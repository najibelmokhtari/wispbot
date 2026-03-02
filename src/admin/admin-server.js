const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const logger = require('../logger');
const { getBotSetting, setBotSetting } = require('../db');

// Persist a session secret to the database so sessions survive restarts
// (works on read-only filesystems and containers without .env mutation)
async function ensureSessionSecret(config) {
    if (process.env.ADMIN_SESSION_SECRET) return;

    // Try to load existing secret from DB
    let secret;
    try {
        secret = await getBotSetting('admin_session_secret');
    } catch (_) { /* DB not ready yet, generate fresh */ }

    if (!secret) {
        secret = crypto.randomBytes(32).toString('hex');
        try {
            await setBotSetting('admin_session_secret', secret);
            logger.info('Admin', 'Auto-generated session secret and saved to database');
        } catch (err) {
            logger.warn('Admin', 'Could not persist session secret to database: ' + err.message);
        }
    }

    process.env.ADMIN_SESSION_SECRET = secret;
    config.adminSessionSecret = secret;
}

async function startAdminServer(config, sharedState) {
    await ensureSessionSecret(config);

    const app = express();
    const port = config.adminPort;
    const host = config.adminHost;
    const basePath = config.adminBasePath;

    // Trust proxy when behind nginx
    if (basePath) app.set('trust proxy', 1);

    // View engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Make basePath available to all templates
    app.locals.basePath = basePath;

    // Middleware (global — not under basePath)
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const cookieOpts = { maxAge: 24 * 60 * 60 * 1000, path: basePath || '/' };
    if (basePath) cookieOpts.secure = true;

    app.use(session({
        secret: config.adminSessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: cookieOpts
    }));

    // Make sharedState and config available to routes
    app.use(async (req, res, next) => {
        req.botConfig = config;
        req.sharedState = sharedState;
        res.locals.botConnected = getConnectionStatus() === 'ready';
        try {
            const botActive = await getBotSetting('bot_active');
            res.locals.botActive = botActive !== '0'; // defaults to true when not set
        } catch {
            res.locals.botActive = true;
        }
        next();
    });

    // CSRF protection middleware
    // Generates a per-session token and validates it on state-changing requests
    function ensureCsrfToken(req) {
        if (req.session && !req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }
    }

    // Make CSRF token available to all templates
    app.use((req, res, next) => {
        ensureCsrfToken(req);
        res.locals.csrfToken = req.session.csrfToken || '';
        next();
    });

    // Validate CSRF on state-changing methods (skip login since no session yet)
    const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
    const CSRF_EXEMPT_PATHS = ['/login', '/api/setup/validate-key'];
    app.use(basePath || '/', (req, res, next) => {
        if (CSRF_SAFE_METHODS.has(req.method)) return next();
        if (CSRF_EXEMPT_PATHS.some(p => req.path === p)) return next();

        const token = req.headers['x-csrf-token'] || req.body?._csrf;
        if (token && req.session.csrfToken && token === req.session.csrfToken) {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
        return res.status(403).send('Invalid CSRF token');
    });

    // Auth middleware
    function requireAuth(req, res, next) {
        if (req.session && req.session.authenticated) {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        res.redirect(basePath + '/login');
    }

    // Routes — mounted under basePath
    const authRoutes = require('./routes/auth');
    const groupRoutes = require('./routes/groups');
    const userRoutes = require('./routes/users');
    const settingsRoutes = require('./routes/settings');
    const personaRoutes = require('./routes/personas');
    const usageRoutes = require('./routes/usage');
    const healthRoutes = require('./routes/health');
    const { router: connectionRoutes, initConnectionCache, getConnectionStatus } = require('./routes/connection');
    const { router: setupRoutes } = require('./routes/setup');

    // Start caching QR codes immediately so they're available
    // even if no browser is connected when the QR event fires
    initConnectionCache(sharedState.whatsappClient);

    // Auto-mark existing installations as setup-complete (seamless upgrade)
    (async () => {
        try {
            const setupComplete = await getBotSetting('setup_complete');
            const botName = await getBotSetting('bot_name');
            if (setupComplete !== '1' && process.env.GEMINI_API_KEY && process.env.ADMIN_PASSWORD && botName) {
                await setBotSetting('setup_complete', '1');
                logger.info('Admin', 'Existing installation detected — auto-marked setup as complete.');
                // Start the WhatsApp connection since the bot.js auto-start
                // may have already checked before this flag was set
                const botModule = require('../bot');
                botModule.startSocket();
            }
        } catch (err) {
            logger.warn('Admin', 'Could not check setup state: ' + err.message);
        }
    })();

    // Setup wizard redirect middleware — before all routes
    // Redirects to /setup if setup is incomplete (except for setup routes, static assets, and health)
    app.use(basePath || '/', async (req, res, next) => {
        // Skip redirect for setup routes, static files, and health checks
        if (req.path.startsWith('/setup') || req.path.startsWith('/api/setup/') ||
            req.path.startsWith('/api/connection/') ||
            req.path.match(/\.(js|css|png|jpg|ico|svg)$/) ||
            req.path.startsWith('/api/health')) {
            return next();
        }
        try {
            const setupComplete = await getBotSetting('setup_complete');
            // Redirect to wizard if setup flag is missing OR essential credentials are gone
            const needsSetup = setupComplete !== '1' || !process.env.GEMINI_API_KEY || !process.env.ADMIN_PASSWORD;
            if (needsSetup) {
                // Reset the flag so the wizard can run again
                if (setupComplete === '1' && (!process.env.GEMINI_API_KEY || !process.env.ADMIN_PASSWORD)) {
                    await setBotSetting('setup_complete', '0');
                    logger.warn('Admin', 'Credentials missing — resetting setup state so wizard can run again.');
                }
                if (req.path.startsWith('/api/')) {
                    return res.status(403).json({ error: 'Setup not complete' });
                }
                return res.redirect(basePath + '/setup');
            }
        } catch (err) {
            logger.warn('Admin', 'Could not check setup state, redirecting to wizard: ' + err.message);
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ error: 'Setup not complete' });
            }
            return res.redirect(basePath + '/setup');
        }
        next();
    });

    // Health endpoint — no auth required
    app.use(basePath || '/', healthRoutes);

    // Setup routes — no auth required (guarded by requireSetupIncomplete internally)
    app.use(basePath || '/', setupRoutes);

    // Connection status — requires auth OR active setup wizard
    // During setup, unauthenticated users need to poll for QR codes.
    // After setup, only authenticated admins should see the QR.
    app.get((basePath || '') + '/api/connection/status', async (req, res) => {
        const isAuthenticated = req.session && req.session.authenticated;
        if (!isAuthenticated) {
            try {
                const setupComplete = await getBotSetting('setup_complete');
                if (setupComplete === '1') {
                    return res.status(401).json({ error: 'Not authenticated' });
                }
            } catch {
                // If we can't check, deny access to be safe
                return res.status(401).json({ error: 'Not authenticated' });
            }
        }
        const botModule = require('../bot');
        const state = botModule.getConnectionState();
        const response = {
            status: state.status,
            message: getConnectionStatus() === 'ready' ? 'WhatsApp is connected' : 'Waiting...'
        };
        if (state.lastQr) response.qr = state.lastQr;
        if (state.lastQrDataUrl) response.qrDataUrl = state.lastQrDataUrl;
        if (state.info) response.info = state.info;
        if (state.alert) response.alert = state.alert;
        res.json(response);
    });

    app.use(basePath || '/', express.static(path.join(__dirname, 'public')));
    app.use(basePath || '/', authRoutes);
    app.use(basePath || '/', requireAuth, groupRoutes);
    app.use(basePath || '/', requireAuth, userRoutes);
    app.use(basePath || '/', requireAuth, personaRoutes);
    app.use(basePath || '/', requireAuth, usageRoutes);
    app.use(basePath || '/', requireAuth, settingsRoutes);
    app.use(basePath || '/', requireAuth, connectionRoutes);

    // Root redirect
    function handleRoot(req, res) {
        res.redirect(basePath + (getConnectionStatus() === 'ready' ? '/groups' : '/connection'));
    }
    if (basePath) {
        app.get(basePath, requireAuth, handleRoot);
        app.get(basePath + '/', requireAuth, handleRoot);
    } else {
        app.get('/', requireAuth, handleRoot);
    }

    app.listen(port, host, async () => {
        const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${basePath}`;

        // Detect setup state to tailor the banner message
        let needsSetup = false;
        try {
            const setupComplete = await getBotSetting('setup_complete');
            needsSetup = setupComplete !== '1' || !process.env.GEMINI_API_KEY || !process.env.ADMIN_PASSWORD;
        } catch { needsSetup = true; }

        const title = needsSetup
            ? '🚀  WispBot Setup Wizard'
            : '✨  WispBot Admin Panel is ready!';
        const link = needsSetup
            ? `👉  Open to get started: ${url}`
            : `🌐  Open in your browser: ${url}`;

        // Emojis occupy 2 columns in terminal but count as 1-2 in .length
        const displayWidth = (s) => {
            let w = 0;
            for (const ch of s) {
                w += ch.codePointAt(0) > 0xFFFF ? 2 : (ch.codePointAt(0) >= 0x2600 ? 2 : 1);
            }
            return w;
        };
        const maxW = Math.max(displayWidth(title), displayWidth(link));
        const padLine = (text) => text + ' '.repeat(maxW - displayWidth(text));
        const border = '═'.repeat(maxW + 6);
        console.log('');
        console.log(`  ╔${border}╗`);
        console.log(`  ║   ${padLine('')}   ║`);
        console.log(`  ║   ${padLine(title)}   ║`);
        console.log(`  ║   ${padLine('')}   ║`);
        console.log(`  ║   ${padLine(link)}   ║`);
        console.log(`  ║   ${padLine('')}   ║`);
        console.log(`  ╚${border}╝`);
        console.log('');

        // Auto-open browser for first-time setup, or if --open flag is passed
        if (needsSetup || process.argv.includes('--open')) {
            const { execFile } = require('child_process');
            const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            execFile(cmd, [url], () => {});
        }
    });
}

module.exports = { startAdminServer };
