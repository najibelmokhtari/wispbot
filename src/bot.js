// --- Puppeteer 23.x compatibility patch for whatsapp-web.js ---
// CRITICAL: This patch MUST run BEFORE require('whatsapp-web.js').
// Client.js destructures `const {exposeFunctionIfAbsent} = require('./util/Puppeteer')`
// at import time, capturing the function value. If we patch after that require,
// the patched function is never used by Client.js.
const puppeteerUtils = require('whatsapp-web.js/src/util/Puppeteer');
puppeteerUtils.exposeFunctionIfAbsent = async function (page, name, fn) {
    try {
        const exist = await page.evaluate((n) => !!window[n], name);
        if (exist) return;
    } catch (e) {
        // Execution context may have been destroyed by a navigation, proceed to try exposing
    }
    try {
        await page.exposeFunction(name, fn);
    } catch (e) {
        if (e.message && e.message.includes('already exists')) {
            // Binding persists across navigations in puppeteer 23.x — this is expected
            return;
        }
        throw e;
    }
};
// --- End patch (now safe to load whatsapp-web.js) ---

const { addPhoneToUsernameMapping } = require('./phone-number-replacer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { dispatch } = require('./commands');
const conversationStore = require('./conversation-store');
const MessageQueueManager = require('./message-queue');
const {
    getDatabase,
    closeDatabase,
    addAddRequest,
    upsertUser,
    setCustomAlias,
    getUserAlias,
    getOrCreateGroupInfo,
    updateGroupInfo,
    isUserAuthorized,
    isUserAdmin,
    importAuthFromFiles,
    getBotSetting,
    setBotSetting
} = require('./db');
const config = require('./config');
const logger = require('./logger');

const BackgroundProcessor = require('./background-processor');
const memoriesHandler = require('./background-handlers/memories');

let messageQueueManager;
let backgroundProcessor;
let messageHandlerSetup = false;

// Dedup: WhatsApp Web store may fire 'add' twice for the same message
const recentMessageIds = new Set();
const MESSAGE_DEDUP_TTL = 5000; // 5 seconds

// Helper to get contact details without crashing (Workaround for whatsapp-web.js issue)
function getSafeContact(message) {
    const author = message.author || message.from;
    const notifyName = message._data.notifyName || 'Unknown User';
    return {
        id: { _serialized: author },
        pushname: notifyName,
        name: notifyName
    };
}

// --- Smart Authorization Check (DB-backed) ---
// Checks if a userId has the given role, resolving @lid to @c.us if necessary
async function checkAuth(client, userId, checkFn) {
    // 1. Direct match check
    if (await checkFn(userId)) {
        return true;
    }

    // 2. If it's an LID, try to find the corresponding phone number (@c.us)
    // The DB often contains @c.us IDs from !authorizeall or manual entry
    if (userId.endsWith('@lid')) {
        try {
            const contact = await client.getContactById(userId);
            const phoneNumber = contact.number || (contact.id ? contact.id.user : null);

            if (phoneNumber) {
                const cUsId = `${phoneNumber}@c.us`;
                if (await checkFn(cUsId)) {
                    return true;
                }
            } else {
                logger.warn('Auth', `Could not resolve phone number for LID ${userId}`);
            }
        } catch (error) {
            logger.error('Auth', `Error resolving LID ${userId} for auth check: ${error.message}`);
        }
    }

    return false;
}

async function checkIsAuthorized(client, userId) {
    return checkAuth(client, userId, isUserAuthorized);
}

async function checkIsAdmin(client, userId) {
    return checkAuth(client, userId, isUserAdmin);
}
// ---------------------------------------------

async function initializeBot() {
    logger.info('Bot', 'Initializing bot...');
    await getDatabase(); // Initialize the database connection

    // One-time import: migrate auth data from .txt files into the DB (only if DB has no auth data yet)
    const imported = await importAuthFromFiles('authorized_numbers.txt', 'admin_numbers.txt');
    if (imported.authorized > 0 || imported.admin > 0) {
        logger.info('Bot', `Imported auth data from text files: ${imported.authorized} authorized, ${imported.admin} admins`);
    }

    // Load saved bot identity from DB (persisted from previous sessions)
    const savedName = await getBotSetting('bot_name');
    const savedUserId = await getBotSetting('bot_user_id');
    const savedNumber = await getBotSetting('bot_number');
    if (savedName) config.botName = savedName;
    if (savedUserId) config.botUserId = savedUserId;
    if (savedNumber) config.botNumber = savedNumber;

    await conversationStore.initialize();
    messageQueueManager = new MessageQueueManager(config);
    await messageQueueManager.initialize();

    // Initialize background processor
    backgroundProcessor = new BackgroundProcessor(config);
    await backgroundProcessor.initialize();
    backgroundProcessor.registerHandler('memories', memoriesHandler);

    // Ensure the image and audio directories exist
    await fs.mkdir(config.imageDirectory, { recursive: true });
    await fs.mkdir(config.audioDirectory, { recursive: true });
    await fs.mkdir(config.memoriesDirectory, { recursive: true });

    if (config.botUserId) {
        addPhoneToUsernameMapping(config.botUserId, config.botName);
    }

    logger.info('Bot', 'Bot initialization complete');
}

// Determine Chrome path based on OS
const platform = require('os').platform();
let executablePath;
if (process.env.CHROME_EXECUTABLE_PATH) {
    executablePath = process.env.CHROME_EXECUTABLE_PATH;
} else if (platform === 'linux') {
    executablePath = '/usr/bin/google-chrome-stable';
} else if (platform === 'darwin') {
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

logger.info('Bot', `Platform: ${platform}`);
// Initialize WhatsApp client
// The default whatsapp-web.js user agent is Chrome/101 (very outdated).
// WhatsApp Web may serve incompatible JS to old browsers. Match the actual Chrome version.
const userAgent = platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36'
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36';

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'sessionName',
        dataPath: './tokens'
    }),
    // Increase auth timeout to 4 minutes for fresh sessions on slow servers
    authTimeoutMs: 240000,
    // Take over the session if another client is using it
    takeoverOnConflict: true,
    // Retry on timeout
    takeoverTimeoutMs: 60000,
    // Override the default Chrome/101 user agent
    userAgent: userAgent,
    // Skip web version caching — load WhatsApp Web fresh from server
    webVersionCache: { type: 'none' },
    puppeteer: {
        headless: true,
        executablePath: executablePath,
        // Increase timeout for puppeteer operations
        timeout: 120000,
        args: platform === 'darwin' ? ['--no-sandbox'] : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--log-level=3',
            '--disable-logging'
        ]
    }
});

// QR Code event
client.on('qr', (qr) => {
    logger.info('Bot', '='.repeat(50));
    logger.info('Bot', 'QR CODE READY');
    logger.info('Bot', '='.repeat(50));
    logger.info('Bot', 'Scan this QR code with WhatsApp mobile app:');
    logger.info('Bot', 'WhatsApp → Linked Devices → Link a Device');
    logger.info('Bot', '='.repeat(50));
    qrcode.generate(qr, { small: true });
    logger.info('Bot', '='.repeat(50));
});

// Loading event
client.on('loading_screen', (percent, message) => {
    logger.info('Bot', `Loading: ${percent}% - ${message}`);
});

// Authentication success
let authEventFired = false;
client.on('authenticated', () => {
    if (authEventFired) return; // Deduplicate — puppeteer 23.x can fire this multiple times
    authEventFired = true;
    logger.info('Bot', 'Authentication successful!');
});

// Fallback: if authenticated fires but ready never does within 60s,
// check if WhatsApp Web actually loaded and manually complete initialization.
let manualReadyAttempted = false;
client.on('authenticated', () => {
    authEventFired = true;
    setTimeout(async () => {
        if (clientReady || manualReadyAttempted) return;
        manualReadyAttempted = true;
        logger.warn('Bot', 'Ready event not received 60s after auth. Checking browser state...');
        try {
            if (!client.pupPage || client.pupPage.isClosed()) {
                logger.warn('Bot', 'Browser page is closed. Cannot recover.');
                return;
            }
            const pageState = await client.pupPage.evaluate(() => ({
                hasStore: typeof window.Store !== 'undefined',
                hasWWebJS: typeof window.WWebJS !== 'undefined',
                title: document.title
            }));
            logger.info('Bot', 'Fallback state: title=' + pageState.title +
                ' | Store=' + pageState.hasStore + ' | WWebJS=' + pageState.hasWWebJS);

            if (!pageState.hasStore) {
                logger.warn('Bot', 'Store not available — WhatsApp Web did not fully load. Will wait for auto-recovery.');
                return;
            }

            // Store is available but ready never fired — the library's injection chain broke.
            // Manually complete what the onAppStateHasSyncedEvent callback should have done.
            logger.info('Bot', 'Store found! Manually completing initialization...');

            if (!pageState.hasWWebJS) {
                const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
                await client.pupPage.evaluate(LoadUtils);
            }

            const { ClientInfo } = require('whatsapp-web.js/src/structures');
            const InterfaceController = require('whatsapp-web.js/src/util/InterfaceController');

            client.info = new ClientInfo(client, await client.pupPage.evaluate(() => ({
                ...window.Store.Conn.serialize(),
                wid: window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeLidUser()
            })));
            client.interface = new InterfaceController(client);

            await client.attachEventListeners();

            // Cancel the 3-minute hard kill
            if (readyTimeout) {
                clearTimeout(readyTimeout);
                readyTimeout = null;
                logger.info('Bot', 'Cancelled 3-minute hard kill timer.');
            }

            logger.info('Bot', 'Manual initialization complete. Emitting ready.');
            client.emit('ready');
        } catch (e) {
            logger.error('Bot', 'Manual recovery failed: ' + e.message);
            logger.info('Bot', 'Will wait for auto-recovery timeout.');
        }
    }, 60000);
});

// Client ready
client.on('ready', async () => {
    // Guard against duplicate ready events (can fire twice during init due to framenavigated + inject)
    if (clientReady) {
        logger.debug('Bot', 'Ignoring duplicate ready event');
        return;
    }
    clientReady = true;
    try {
        logger.info('Bot', 'Client is ready!');
        await initializeBot();

        // Auto-detect bot identity from WhatsApp connection
        if (client.info && client.info.wid) {
            const detectedUserId = client.info.wid._serialized;
            const detectedNumber = client.info.wid.user;
            const detectedPushname = client.info.pushname || '';

            await setBotSetting('bot_user_id', detectedUserId);
            await setBotSetting('bot_number', detectedNumber);
            await setBotSetting('bot_pushname', detectedPushname);

            // Only set bot_name if not already configured (preserve user edits)
            const existingName = await getBotSetting('bot_name');
            if (!existingName) {
                await setBotSetting('bot_name', detectedPushname || config.botName);
            }

            // Update config in-place (propagates to all consumers by reference)
            config.botUserId = detectedUserId;
            config.botNumber = detectedNumber;
            config.botName = (await getBotSetting('bot_name')) || config.botName;

            // Also detect bot's LID (Linked ID) — WhatsApp mentions now use LID format
            try {
                const lidUser = await client.pupPage.evaluate(() =>
                    window.Store.User.getMaybeMeLidUser()
                );
                if (lidUser && lidUser._serialized) {
                    config.botLidUserId = lidUser._serialized;
                    logger.info('Bot', `Bot LID: ${config.botLidUserId}`);
                }
            } catch (e) {
                logger.warn('Bot', 'Could not detect bot LID: ' + e.message);
            }

            addPhoneToUsernameMapping(config.botUserId, config.botName);
            logger.info('Bot', `Bot identity: ${config.botName} (${detectedNumber}, ${detectedUserId})`);
        }

        // Mark bot as "online" so typing indicators are visible in DM chats
        try {
            await client.sendPresenceAvailable();
        } catch (e) {
            logger.warn('Bot', 'Could not set presence available: ' + e.message);
        }

        setupMessageHandler();

        logger.info('Bot', 'Bot successfully started and ready to receive messages!');
    } catch (error) {
        logger.error('Bot', `Error during bot initialization: ${error.message}`);
        logger.error('Bot', error.stack);
    }
});

// Authentication failure
client.on('auth_failure', msg => {
    logger.error('Bot', 'Authentication failure: ' + msg);
});

// Disconnected
client.on('disconnected', (reason) => {
    logger.warn('Bot', 'Client was disconnected: ' + reason);
    clientReady = false;
});

// State change
client.on('change_state', state => {
    logger.info('Bot', 'Client state changed: ' + state);
});

// Initialize and start the client
logger.info('Bot', 'Initializing WhatsApp client...');

// Auto-recovery: if client doesn't become ready within 3 minutes,
// destroy the stale session and re-initialize to force a fresh QR scan.
let readyTimeout = null;
let clientReady = false;

// Periodic diagnostic: check if Debug.VERSION appears during auth wait
let diagInterval = null;
function startDebugVersionPolling() {
    let pollCount = 0;
    diagInterval = setInterval(async () => {
        pollCount++;
        try {
            if (!client.pupPage || client.pupPage.isClosed()) return;
            const state = await client.pupPage.evaluate(() => ({
                url: location.href,
                hasDebug: typeof window.Debug !== 'undefined',
                version: window.Debug?.VERSION,
                title: document.title,
                // Extra diagnostics: check for key WhatsApp Web globals
                hasRequire: typeof window.require !== 'undefined',
                hasWebpackJsonp: typeof window.webpackChunkwhatsapp_web_client !== 'undefined',
                scriptCount: document.querySelectorAll('script').length,
                errorCount: window.__wwjsErrors?.length || 0,
                userAgent: navigator.userAgent,
            }));
            logger.debug('Browser', `Poll #${pollCount}: url=${state.url} | Debug=${state.hasDebug} | version=${state.version || 'undefined'} | title=${state.title} | scripts=${state.scriptCount} | UA=${pollCount === 1 ? state.userAgent : '(skip)'}`);
            if (state.version) {
                logger.info('Browser', 'Debug.VERSION found! WhatsApp Web initialized. Stopping poll.');
                clearInterval(diagInterval);
            }
        } catch (e) {
            logger.error('Browser', `Debug poll #${pollCount} error: ${e.message}`);
        }
    }, 15000); // every 15 seconds
}

function startReadyTimeout() {
    clientReady = false;
    authEventFired = false;
    manualReadyAttempted = false;
    startDebugVersionPolling();
    readyTimeout = setTimeout(async () => {
        if (clientReady) return;
        logger.warn('Bot', 'Client has not become ready after 3 minutes!');

        // Capture diagnostics before destroying
        try {
            if (client.pupPage && !client.pupPage.isClosed()) {
                const diag = await client.pupPage.evaluate(() => ({
                    url: location.href,
                    title: document.title,
                    hasDebug: typeof window.Debug !== 'undefined',
                    debugVersion: window.Debug?.VERSION,
                    bodyText: document.body?.innerText?.substring(0, 500)
                }));
                logger.info('Browser', 'Diagnostics: ' + JSON.stringify(diag));
            }
        } catch (e) {
            logger.error('Browser', 'Could not capture diagnostics: ' + e.message);
        }

        // Delete stale session data so a fresh QR code is generated on restart
        try {
            const tokensPath = path.join(__dirname, '..', 'tokens');
            if (fsSync.existsSync(tokensPath)) {
                fsSync.rmSync(tokensPath, { recursive: true, force: true });
                logger.info('Bot', 'Deleted stale tokens directory.');
            }
        } catch (e) {
            logger.error('Bot', 'Error deleting tokens: ' + e.message);
        }

        // Exit process and let PM2 restart cleanly instead of reusing stale client state
        logger.info('Bot', 'Exiting process for clean restart (PM2 will restart automatically)...');
        process.exit(1);
    }, 180000); // 3 minutes
}

client.on('ready', () => {
    clientReady = true;
    if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
    }
    if (diagInterval) {
        clearInterval(diagInterval);
        diagInterval = null;
    }
});

startReadyTimeout();

// Catch any unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Bot', 'Unhandled Rejection at: ' + promise);
    logger.error('Bot', 'Reason: ' + (reason instanceof Error ? reason.stack : JSON.stringify(reason)));
});

// Pre-flight check for Chrome
if (executablePath && !fsSync.existsSync(executablePath)) {
    logger.error('Bot', 'FATAL: Chrome executable not found at: ' + executablePath);
    process.exit(1);
}
logger.info('Bot', 'Chrome executable: ' + (executablePath || 'puppeteer bundled'));

// Start admin web panel early (doesn't need WhatsApp to be ready)
(async () => {
    try {
        await getDatabase();
        const { startAdminServer } = require('./admin/admin-server');
        startAdminServer(config, {
            whatsappClient: client,
            get messageQueueManager() { return messageQueueManager; }
        });
    } catch (err) {
        logger.error('Admin', 'Error starting admin panel: ' + err.message);
    }
})();

// --- Browser diagnostics: forward Chrome console to Node logs ---
// Use a property setter trap to attach diagnostics as soon as pupPage is assigned
// (before inject() runs, so we can see what happens during auth timeout)
let _pupPageDiagAttached = false;
let _pupPageValue = client.pupPage;
Object.defineProperty(client, 'pupPage', {
    get() { return _pupPageValue; },
    set(page) {
        _pupPageValue = page;
        if (page && !_pupPageDiagAttached) {
            _pupPageDiagAttached = true;

            // CRITICAL FIX: Skip the whatsapp-web.js Error constructor replacement.
            // Client.js replaces the global Error with a wrapper to hide moduleRaid from
            // stack traces. This is an "isOfficialClient" bypass that's ONLY needed for
            // the legacy (pre-2.3000) code path. On 2.3000+ (comet), moduleRaid isn't used
            // so the replacement is a no-op with harmful side effects:
            //   - Strips Error.captureStackTrace (V8 internal, used by WhatsApp Web)
            //   - Breaks prototype chain for "class X extends Error"
            //   - Can cause WhatsApp Web's initialization to silently fail
            // We intercept evaluateOnNewDocument and block the Error replacement.
            const origEvalOnNewDoc = page.evaluateOnNewDocument.bind(page);
            page.evaluateOnNewDocument = function (fn, ...args) {
                const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
                if (fnStr.includes('moduleRaid') || fnStr.includes('originalError')) {
                    logger.info('Browser', 'Blocked obsolete Error constructor replacement (isOfficialClient patch)');
                    return Promise.resolve();
                }
                return origEvalOnNewDoc(fn, ...args);
            };

            // Forward browser console to server logs
            // Log ALL types for first 60s to diagnose init failure, then only errors
            let _browserLogCount = 0;
            const _diagStart = Date.now();
            page.on('console', msg => {
                const type = msg.type();
                const elapsed = Date.now() - _diagStart;
                // During first 60s: log everything (cap 100); after: only errors (cap 30)
                if (elapsed < 60000) {
                    if (_browserLogCount >= 100) return;
                } else {
                    if (type !== 'error' && type !== 'warning') return;
                    if (_browserLogCount >= 130) return;
                }
                const text = msg.text();
                if (text.includes('Caught in:') || text.includes('ErrorUtils') || text.includes('non-fatal')) return;
                _browserLogCount++;
                logger.debug('Browser', `[${type}] ${text}`);
            });
            // Log page errors (uncaught exceptions in the browser)
            page.on('pageerror', err => {
                logger.error('Browser', 'Page error: ' + err.message + '\n' + err.stack);
            });
            // Log navigations for debugging context destruction
            page.on('framenavigated', frame => {
                if (frame === page.mainFrame()) {
                    logger.info('Browser', 'Navigated to ' + frame.url());
                }
            });
            // Log page request failures (network issues)
            page.on('requestfailed', req => {
                logger.warn('Browser', 'Request failed: ' + req.url() + ' - ' + (req.failure()?.errorText || 'unknown'));
            });
            logger.info('Browser', 'Browser page hooks attached');
        }
    },
    configurable: true,
    enumerable: true
});

// Monkey-patch attachEventListeners to fix missing Store modules in newer WhatsApp Web.
// Runs after ExposeStore has populated window.Store but before event listeners are registered.
const _originalAttachEventListeners = client.attachEventListeners.bind(client);
client.attachEventListeners = async function () {
    await this.pupPage.evaluate(() => {
        // Store.Call may not exist in newer WhatsApp Web. Without this,
        // Store.Call.on('add', ...) at Client.js:732 throws and prevents ALL
        // subsequent listeners (Chat.on, Msg.on) from being registered.
        if (!window.Store.Call || typeof window.Store.Call.on !== 'function') {
            console.warn('[waaibot] Patching missing Store.Call with no-op');
            window.Store.Call = { on: () => { }, get: () => null };
        }

        // Store.GroupMetadata may not exist in comet (v2.3000+) WhatsApp Web.
        // getChatModel() calls Store.GroupMetadata.update(chatWid) to refresh
        // group metadata before serializing. Without this stub, getChat() crashes
        // with "Cannot read properties of undefined (reading 'update')".
        // The no-op just skips the refresh — cached metadata is used instead.
        if (!window.Store.GroupMetadata || typeof window.Store.GroupMetadata.update !== 'function') {
            console.warn('[waaibot] Patching missing Store.GroupMetadata with no-op');
            window.Store.GroupMetadata = { update: () => Promise.resolve() };
        }

        // Patch DownloadManager.downloadAndMaybeDecrypt to handle addAnnotations error.
        // In newer WhatsApp Web, downloadAndMaybeDecrypt calls addAnnotations on a module
        // that doesn't exist, causing "Cannot read properties of undefined (reading 'addAnnotations')".
        // This wrapper catches that specific error and returns null, letting the Node-side fallback handle it.
        if (window.Store.DownloadManager && window.Store.DownloadManager.downloadAndMaybeDecrypt) {
            const _origDownloadAndMaybeDecrypt = window.Store.DownloadManager.downloadAndMaybeDecrypt.bind(window.Store.DownloadManager);
            window.Store.DownloadManager.downloadAndMaybeDecrypt = async function (...args) {
                try {
                    return await _origDownloadAndMaybeDecrypt(...args);
                } catch (e) {
                    if (e && e.message && e.message.includes('addAnnotations')) {
                        console.warn('[waaibot] downloadAndMaybeDecrypt failed with addAnnotations error, returning null for Node-side fallback');
                        return null;
                    }
                    throw e; // Re-throw other errors
                }
            };
            console.log('[waaibot] Patched DownloadManager.downloadAndMaybeDecrypt with addAnnotations fallback');
        }
    });

    const result = await _originalAttachEventListeners();

    // Wrap WWebJS.sendSeen so that failures don't prevent message sending.
    // In comet WhatsApp Web, Store.SendSeen.sendSeen may crash accessing
    // 'markedUnread' on an undefined property. sendSeen is called inside the
    // sendMessage evaluate BEFORE the actual send — if it throws, the entire
    // evaluate rejects and the message is never sent.
    await this.pupPage.evaluate(() => {
        if (window.WWebJS && window.WWebJS.sendSeen) {
            const _origSendSeen = window.WWebJS.sendSeen;
            window.WWebJS.sendSeen = async (chatId) => {
                try {
                    return await _origSendSeen(chatId);
                } catch (e) {
                    console.warn('[waaibot] sendSeen failed (non-fatal):', e.message);
                }
            };
        }
    });

    return result;
};

client.initialize().catch(async (err) => {
    logger.error('Bot', '='.repeat(50));
    logger.error('Bot', 'CLIENT INITIALIZATION FAILED');
    logger.error('Bot', '='.repeat(50));
    if (err instanceof Error) {
        logger.error('Bot', 'Error message: ' + err.message);
        logger.error('Bot', 'Error name: ' + err.name);
        logger.error('Bot', 'Error stack: ' + err.stack);
    } else if (err === undefined) {
        logger.error('Bot', 'Error is undefined - this usually means:');
        logger.error('Bot', '  1. Puppeteer/Chrome crashed without throwing a proper error');
        logger.error('Bot', '  2. Session data in ./tokens may be corrupted');
        logger.error('Bot', '  3. Memory or resource issue on the server');
    } else {
        logger.error('Bot', 'Non-Error rejection value: ' + JSON.stringify(err, null, 2));
        logger.error('Bot', 'Type: ' + typeof err);
    }
    logger.error('Bot', '='.repeat(50));

    // Capture browser diagnostics before exiting
    try {
        if (client.pupPage && !client.pupPage.isClosed()) {
            const diag = await client.pupPage.evaluate(() => ({
                url: location.href,
                title: document.title,
                hasDebug: typeof window.Debug !== 'undefined',
                debugVersion: window.Debug?.VERSION,
                bodyText: document.body?.innerText?.substring(0, 500)
            }));
            logger.info('Browser', 'State at failure: ' + JSON.stringify(diag));
        }
    } catch (e) {
        logger.error('Browser', 'Could not capture state: ' + e.message);
    }

    // Auth timeout or other init failure — exit for clean PM2 restart
    // (no point waiting for the 3-minute ready timeout)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('timeout') || errMsg.includes('auth timeout')) {
        logger.warn('Bot', 'Auth timeout detected. Deleting tokens and exiting for clean restart...');
        try {
            const tokensPath = path.join(__dirname, '..', 'tokens');
            if (fsSync.existsSync(tokensPath)) {
                fsSync.rmSync(tokensPath, { recursive: true, force: true });
                logger.info('Bot', 'Deleted stale tokens directory.');
            }
        } catch (e) {
            logger.error('Bot', 'Error deleting tokens: ' + e.message);
        }
        // Short delay to let logs flush
        setTimeout(() => process.exit(1), 2000);
    }
});

function setupMessageHandler() {
    if (messageHandlerSetup) {
        logger.warn('Bot', 'setupMessageHandler called again — skipping duplicate registration');
        return;
    }
    messageHandlerSetup = true;
    client.on('message', async (message) => {
        // Ignore messages sent by the bot itself to prevent infinite loops
        if (message.fromMe) return;

        // Dedup: WhatsApp Web store may fire 'add' twice for the same message
        const msgId = message.id._serialized || message.id.id;
        if (recentMessageIds.has(msgId)) {
            logger.debug('Message', `Skipping duplicate message: ${msgId}`);
            return;
        }
        recentMessageIds.add(msgId);
        setTimeout(() => recentMessageIds.delete(msgId), MESSAGE_DEDUP_TTL);

        logger.info('Message', `Received message: ${message.body}`);
        const chat = await message.getChat();
        logger.debug('Message', `Is group message: ${chat.isGroup}`);

        // FIX: Use getSafeContact instead of message.getContact()
        const contact = getSafeContact(message);
        logger.debug('Message', `Sender: ${contact.id._serialized}`);

        // --- NEW: Sync User Data ---
        // Capture the user's current profile name on every message
        const senderId = contact.id._serialized;
        const profileName = contact.pushname || contact.name || 'Unknown User';
        try {
            await upsertUser(senderId, profileName);
        } catch (error) {
            logger.error('Message', 'Error syncing user data: ' + error.message);
        }
        // ---------------------------

        // --- Passive auto-registration: ensure group/DM is in DB ---
        try {
            const chatName = chat.isGroup
                ? (chat.name || 'Group Chat')
                : (chat.name || contact.pushname || contact.name || 'Direct Message');
            const regInfo = await getOrCreateGroupInfo(message.from, chatName);
            // Fix: retroactively update group name if it was stored as the raw group ID
            if (chatName !== message.from && regInfo.group_name === regInfo.group_id) {
                await updateGroupInfo(message.from, { group_name: chatName });
            }
        } catch (error) {
            logger.error('Message', 'Error auto-registering chat: ' + error.message);
        }
        // ---------------------------

        // For DMs, attach the contact name so it can be stored instead of "Direct Message"
        if (!chat.isGroup) {
            message.dmContactName = chat.name || contact.pushname || contact.name || 'Direct Message';
        }

        // Process and store all messages, regardless of bot involvement
        try {
            await processAndStoreMessage(client, message);
        } catch (storeError) {
            logger.error('Store', 'Failed to store message, continuing with bot logic: ' + storeError.message);
        }

        // Feed message to background processor (groups only, fire-and-forget)
        if (chat.isGroup && backgroundProcessor) {
            try {
                backgroundProcessor.feedMessage(message.from);
            } catch (bgErr) {
                logger.error('Background', 'Error feeding message: ' + bgErr.message);
            }
        }

        // FIX: Avoid message.getMentions() which triggers the crash
        const mentionedIds = message.mentionedIds || [];

        const isBotMentioned = mentionedIds.includes(config.botUserId)
            || (config.botLidUserId && mentionedIds.includes(config.botLidUserId))
            || message.body.includes(`@${config.botName}`);
        logger.debug('Message', `Mention check: mentionedIds=${JSON.stringify(mentionedIds)}, botUserId=${config.botUserId}, botLid=${config.botLidUserId}, isBotMentioned=${isBotMentioned}`);
        const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;

        // FIX: Safe way to check reply participant without crashing
        // Check both regular user ID and LID — WhatsApp now uses LID for message authorship
        const quotedAuthor = quotedMessage ? (quotedMessage.author || quotedMessage.from) : null;
        const isReplyToBot = quotedAuthor
            ? (quotedAuthor === config.botUserId
                || (config.botLidUserId && quotedAuthor === config.botLidUserId))
            : false;

        if (quotedMessage) {
            logger.debug('Message', `Reply check: quotedAuthor=${quotedAuthor}, botUserId=${config.botUserId}, botLid=${config.botLidUserId}, isReplyToBot=${isReplyToBot}`);
        }

        // Extract command from message body
        const commandMatch = message.body.match(/!(\w+)/);
        const hasCommand = commandMatch !== null;

        if (hasCommand) {
            const fullCommand = commandMatch[0]; // e.g., "!ping"
            const commandName = commandMatch[1].toLowerCase(); // e.g., "ping"

            // 1. !addme (Public Command)
            if (commandName === 'addme') {
                if (chat.isGroup) {
                    const args = message.body.slice(fullCommand.length).trim();

                    if (args.length > 0) {
                        await setCustomAlias(senderId, args);
                    }

                    const storedAlias = await getUserAlias(senderId);

                    await addAddRequest(senderId, storedAlias);
                    await client.sendMessage(message.from, `Hi ${storedAlias}, your request to be added has been sent to the admins.`);
                } else {
                    await client.sendMessage(message.from, 'You can only use this command in a group with the bot.');
                }
                return;
            }

            // Authorization Check (DB-backed)
            const isAuthorized = await checkIsAuthorized(client, senderId);
            const isAdmin = await checkIsAdmin(client, senderId);

            // 2. !usage (Authorized Users OR Admins)
            if (commandName === 'usage') {
                if (!isAuthorized && !isAdmin) {
                    await client.sendMessage(message.from, `Sorry ${contact.pushname}, you are not authorized to use this command.`);
                    return;
                }
            }
            // 3. All other commands (Admins Only)
            else {
                if (!isAdmin) {
                    logger.warn('Auth', `Unauthorized user ${senderId} (${contact.pushname}) attempted to use an admin command`);
                    await client.sendMessage(message.from, `Sorry ${contact.pushname}, only admins can use bot commands.`);
                    return;
                }
            }

            // Dispatch the command to the appropriate handler
            await dispatch(`!${commandName}`, client, message, {
                ...config,
                messageQueueManager
            });

        } else if (chat.isGroup && (isBotMentioned || isReplyToBot)) {
            // Group chat: bot invocation via mention or reply
            // Check if authorization is enabled for this group
            const groupInfo = await getOrCreateGroupInfo(message.from, chat.name || 'Group Chat');

            // Fix: retroactively update group name if it was stored as the raw group ID
            if (chat.name && groupInfo.group_name === groupInfo.group_id) {
                await updateGroupInfo(message.from, { group_name: chat.name });
            }

            // Skip AI for inactive (unconfigured) groups
            if (!groupInfo.is_active) {
                logger.debug('Message', `Skipping AI for inactive group ${message.from}`);
                return;
            }

            const authCheckEnabled = groupInfo.authorization_check_enabled !== 0; // Default to true if undefined

            if (!authCheckEnabled) {
                // Authorization is disabled for this group - allow any member to invoke bot
                await handleBotInvocation(client, message);
            } else {
                // Authorization is enabled - check if user is authorized
                const isAuthorized = await checkIsAuthorized(client, contact.id._serialized);
                const isAdmin = await checkIsAdmin(client, contact.id._serialized);

                if (isAuthorized || isAdmin) {
                    await handleBotInvocation(client, message);
                } else {
                    logger.warn('Auth', `Unauthorized user ${contact.id._serialized} (${contact.pushname}) attempted to invoke bot`);
                }
            }

        } else if (!chat.isGroup) {
            // 1-1 chat: allow admins to chat directly with the bot
            const isAdmin = await checkIsAdmin(client, contact.id._serialized);
            if (isAdmin) {
                await handleBotInvocation(client, message);
            }
        }
    });

    process.on('SIGINT', async () => {
        logger.info('Bot', 'Shutting down...');
        if (backgroundProcessor) backgroundProcessor.destroy();
        await closeDatabase(); // Close the database connection
        process.exit(0);
    });
}

async function processAndStoreMessage(client, message) {
    let imageId = null;
    let messageText = message.body || 'Sent a message';

    if (message.hasMedia && message.type === 'image') {
        imageId = await processAndStoreImage(client, message);
        message.imageId = imageId; // Attach ID to message object for bot context
        messageText = `Sent image id: ${imageId}`;
    }

    let audioId = null;
    if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        // Check audio duration cap before processing
        const groupInfo = await getOrCreateGroupInfo(message.from, message.groupInfo?.name || message.dmContactName || 'Unknown Group');
        const durationCap = groupInfo.audio_duration_cap;
        const audioDuration = message.duration || 0;

        if (durationCap && durationCap > 0 && audioDuration > durationCap) {
            logger.info('Audio', `Audio message ${message.id._serialized} exceeds duration cap (${audioDuration}s > ${durationCap}s)`);
            messageText = `Sent an audio message (${audioDuration}s) that exceeded the duration cap (${durationCap}s)`;
            message.audioDurationExceeded = true;
        } else {
            audioId = await processAndStoreAudio(client, message);
            message.audioId = audioId; // Attach ID to message object for bot context
            messageText = `Sent audio id: ${audioId}`;
        }
    }

    const contact = getSafeContact(message);
    const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;

    const newMessage = {
        sender: contact.pushname || contact.name || 'Unknown User',
        senderId: contact.id._serialized,
        message: messageText,
        timestamp: new Date(message.timestamp * 1000).toISOString(),
        quotedMsg: quotedMessage ? quotedMessage.body : null,
        imageId: imageId,
        audioId: audioId,
        quotedParticipant: quotedMessage ? (quotedMessage.author || quotedMessage.from) : null,
        whatsappMessageId: message.id._serialized,
        quotedWhatsappMessageId: quotedMessage ? quotedMessage.id._serialized : null
    };

    await conversationStore.addMessageToConversation(message.from, newMessage);
    addPhoneToUsernameMapping(contact.id._serialized, contact.pushname || contact.name || 'Unknown User');
}

async function processAndStoreImage(client, message) {
    const msgId = message.id._serialized;
    try {
        logger.info('Image', `Downloading media for message ${msgId}...`);

        // --- Attempt 1: Standard whatsapp-web.js downloadMedia() ---
        let media = null;
        try {
            media = await message.downloadMedia();
        } catch (downloadError) {
            logger.warn('Image', `Standard downloadMedia() failed for ${msgId}: ${downloadError.message}`);
        }

        // --- Attempt 2: Fallback via pupPage.evaluate ---
        // If standard path failed (e.g., addAnnotations error), try accessing
        // the media blob directly through the WhatsApp model's own download mechanism.
        if (!media || !media.data) {
            logger.info('Image', `Trying fallback download for ${msgId}...`);
            try {
                const fallbackResult = await client.pupPage.evaluate(async (msgId) => {
                    const msg = window.Store.Msg.get(msgId)
                        || (await window.Store.Msg.getMessagesById([msgId]))?.messages?.[0];
                    if (!msg) return null;

                    // Trigger the model-level download (resolves media into mediaData)
                    if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
                        try {
                            await msg.downloadMedia({
                                downloadEvenIfExpensive: true,
                                rmrReason: 1
                            });
                        } catch (e) {
                            console.warn('[waaibot] Model downloadMedia failed:', e.message);
                        }
                    }

                    // Try to get the blob from the media object (already decrypted in-browser)
                    if (msg.mediaData && msg.mediaData.mediaBlob) {
                        try {
                            const blob = msg.mediaData.mediaBlob;
                            // mediaBlob might be an OpaqueData instance; get the actual Blob
                            const actualBlob = blob._blob || blob;
                            if (actualBlob instanceof Blob) {
                                const arrayBuf = await actualBlob.arrayBuffer();
                                const bytes = new Uint8Array(arrayBuf);
                                let binary = '';
                                for (let i = 0; i < bytes.length; i++) {
                                    binary += String.fromCharCode(bytes[i]);
                                }
                                return {
                                    data: btoa(binary),
                                    mimetype: msg.mimetype || 'image/jpeg',
                                    filename: msg.filename || null,
                                    filesize: bytes.length
                                };
                            }
                        } catch (blobErr) {
                            console.warn('[waaibot] Blob extraction failed:', blobErr.message);
                        }
                    }

                    // Last resort: check if renderableUrl exists and try to fetch from it
                    if (msg.mediaData && msg.mediaData.renderableUrl) {
                        try {
                            const response = await fetch(msg.mediaData.renderableUrl);
                            const arrayBuf = await response.arrayBuffer();
                            const bytes = new Uint8Array(arrayBuf);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) {
                                binary += String.fromCharCode(bytes[i]);
                            }
                            return {
                                data: btoa(binary),
                                mimetype: msg.mimetype || 'image/jpeg',
                                filename: msg.filename || null,
                                filesize: bytes.length
                            };
                        } catch (fetchErr) {
                            console.warn('[waaibot] renderableUrl fetch failed:', fetchErr.message);
                        }
                    }

                    return null;
                }, msgId);

                if (fallbackResult && fallbackResult.data) {
                    logger.info('Image', `Fallback download succeeded for ${msgId} (${fallbackResult.filesize} bytes)`);
                    media = fallbackResult;
                } else {
                    logger.warn('Image', `Fallback download returned no data for ${msgId}`);
                }
            } catch (fallbackError) {
                logger.error('Image', `Fallback download failed for ${msgId}: ${fallbackError.message}`);
            }
        }

        if (!media || !media.data) {
            logger.warn('Image', `All download attempts failed for ${msgId}`);
            return null;
        }

        const imageBuffer = Buffer.from(media.data, 'base64');
        const imageId = `img_${Date.now()}`;
        const imagePath = path.join(config.imageDirectory, `${imageId}.jpg`);
        await fs.writeFile(imagePath, imageBuffer);
        logger.info('Image', `Stored image: ${imagePath} with ID: ${imageId} (${imageBuffer.length} bytes)`);
        return imageId;
    } catch (error) {
        logger.error('Image', `Error storing image for ${msgId}: ${error.message}`);
        logger.error('Image', `Stack: ${error.stack}`);
        return null;
    }
}

async function processAndStoreAudio(client, message) {
    const msgId = message.id._serialized;
    try {
        logger.info('Audio', `Downloading media for message ${msgId}...`);

        // --- Attempt 1: Standard whatsapp-web.js downloadMedia() ---
        let media = null;
        try {
            media = await message.downloadMedia();
        } catch (downloadError) {
            logger.warn('Audio', `Standard downloadMedia() failed for ${msgId}: ${downloadError.message}`);
        }

        // --- Attempt 2: Fallback via pupPage.evaluate ---
        if (!media || !media.data) {
            logger.info('Audio', `Trying fallback download for ${msgId}...`);
            try {
                const fallbackResult = await client.pupPage.evaluate(async (msgId) => {
                    const msg = window.Store.Msg.get(msgId)
                        || (await window.Store.Msg.getMessagesById([msgId]))?.messages?.[0];
                    if (!msg) return null;

                    if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
                        try {
                            await msg.downloadMedia({
                                downloadEvenIfExpensive: true,
                                rmrReason: 1
                            });
                        } catch (e) {
                            console.warn('[waaibot] Model downloadMedia failed:', e.message);
                        }
                    }

                    if (msg.mediaData && msg.mediaData.mediaBlob) {
                        try {
                            const blob = msg.mediaData.mediaBlob;
                            const actualBlob = blob._blob || blob;
                            if (actualBlob instanceof Blob) {
                                const arrayBuf = await actualBlob.arrayBuffer();
                                const bytes = new Uint8Array(arrayBuf);
                                let binary = '';
                                for (let i = 0; i < bytes.length; i++) {
                                    binary += String.fromCharCode(bytes[i]);
                                }
                                return {
                                    data: btoa(binary),
                                    mimetype: msg.mimetype || 'audio/ogg',
                                    filename: msg.filename || null,
                                    filesize: bytes.length
                                };
                            }
                        } catch (blobErr) {
                            console.warn('[waaibot] Blob extraction failed:', blobErr.message);
                        }
                    }

                    if (msg.mediaData && msg.mediaData.renderableUrl) {
                        try {
                            const response = await fetch(msg.mediaData.renderableUrl);
                            const arrayBuf = await response.arrayBuffer();
                            const bytes = new Uint8Array(arrayBuf);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) {
                                binary += String.fromCharCode(bytes[i]);
                            }
                            return {
                                data: btoa(binary),
                                mimetype: msg.mimetype || 'audio/ogg',
                                filename: msg.filename || null,
                                filesize: bytes.length
                            };
                        } catch (fetchErr) {
                            console.warn('[waaibot] renderableUrl fetch failed:', fetchErr.message);
                        }
                    }

                    return null;
                }, msgId);

                if (fallbackResult && fallbackResult.data) {
                    logger.info('Audio', `Fallback download succeeded for ${msgId} (${fallbackResult.filesize} bytes)`);
                    media = fallbackResult;
                } else {
                    logger.warn('Audio', `Fallback download returned no data for ${msgId}`);
                }
            } catch (fallbackError) {
                logger.error('Audio', `Fallback download failed for ${msgId}: ${fallbackError.message}`);
            }
        }

        if (!media || !media.data) {
            logger.warn('Audio', `All download attempts failed for ${msgId}`);
            return null;
        }

        const extension = media.mimetype.split('/')[1].split(';')[0] || 'ogg';
        const audioBuffer = Buffer.from(media.data, 'base64');
        const audioId = `audio_${Date.now()}`;
        const audioPath = path.join(config.audioDirectory, `${audioId}.${extension}`);
        await fs.writeFile(audioPath, audioBuffer);
        logger.info('Audio', `Stored audio: ${audioPath} with ID: ${audioId} (${audioBuffer.length} bytes)`);
        return audioId;
    } catch (error) {
        logger.error('Audio', `Error storing audio for ${msgId}: ${error.message}`);
        logger.error('Audio', `Stack: ${error.stack}`);
        return null;
    }
}

async function handleBotInvocation(client, message) {
    const contact = getSafeContact(message);

    // Authorization is already checked in the message handler
    // This function is only called after authorization has been verified

    // If the user's audio was rejected due to duration cap, notify and stop
    if (message.audioDurationExceeded) {
        const groupInfo = await getOrCreateGroupInfo(message.from, 'Unknown Group');
        const cap = groupInfo.audio_duration_cap || 900;
        const capMinutes = Math.floor(cap / 60);
        const capLabel = capMinutes >= 1 ? `${capMinutes} minute${capMinutes !== 1 ? 's' : ''}` : `${cap} seconds`;
        await client.sendMessage(message.from, `Sorry, I couldn't process that audio because it's too long. The maximum duration is ${capLabel}.`);
        return;
    }

    const useExtendedHistory = message.body.includes(config.extendedHistoryCode);
    let historyLimit = useExtendedHistory ? config.extendedMessageHistoryLimit : config.messageHistoryLimit;

    // Check for a group-specific custom limit, falling back to global default from settings
    try {
        const groupInfo = await getOrCreateGroupInfo(message.from, 'Unknown Group');
        if (!useExtendedHistory) {
            if (groupInfo.custom_message_limit) {
                historyLimit = groupInfo.custom_message_limit;
            } else {
                const globalDefault = await getBotSetting('default_message_history_limit');
                if (globalDefault) {
                    historyLimit = parseInt(globalDefault);
                }
            }
        }
    } catch (error) {
        logger.error('Message', 'Error loading message history limit: ' + error.message);
    }

    if (messageQueueManager) {
        await messageQueueManager.queueMessage(client, message, historyLimit);
    } else {
        logger.error('Message', 'MessageQueueManager is not initialized');
        await client.sendMessage(message.from, 'Sorry, there was an error processing your request. Please try again later.');
    }
}

module.exports = { initializeBot };