require('dotenv').config();
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function log(level, context, message) {
    if (LEVELS[level] < currentLevel) return;
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level}] [${context}] ${message}`);
}

module.exports = {
    debug: (ctx, msg) => log('DEBUG', ctx, msg),
    info:  (ctx, msg) => log('INFO',  ctx, msg),
    warn:  (ctx, msg) => log('WARN',  ctx, msg),
    error: (ctx, msg) => log('ERROR', ctx, msg),
};
