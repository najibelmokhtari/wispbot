const express = require('express');
const session = require('express-session');
const path = require('path');
const logger = require('../logger');

function startAdminServer(config, sharedState) {
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

    app.use(session({
        secret: config.adminSessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 24 * 60 * 60 * 1000, path: basePath || '/' }
    }));

    // Make sharedState and config available to routes
    app.use((req, res, next) => {
        req.botConfig = config;
        req.sharedState = sharedState;
        res.locals.botConnected = getConnectionStatus() === 'ready';
        next();
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
    const healthRoutes = require('./routes/health');
    const { router: connectionRoutes, initConnectionCache, getConnectionStatus } = require('./routes/connection');

    // Start caching QR codes immediately so they're available
    // even if no browser is connected when the QR event fires
    initConnectionCache(sharedState.whatsappClient);

    // Health endpoint — no auth required
    app.use(basePath || '/', healthRoutes);

    app.use(basePath || '/', express.static(path.join(__dirname, 'public')));
    app.use(basePath || '/', authRoutes);
    app.use(basePath || '/', requireAuth, groupRoutes);
    app.use(basePath || '/', requireAuth, userRoutes);
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

    app.listen(port, host, () => {
        logger.info('Admin', `Admin panel running at http://${host}:${port}${basePath}`);
    });
}

module.exports = { startAdminServer };
