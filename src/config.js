require('dotenv').config();
const crypto = require('crypto');
const logger = require('./logger');

// --- Required env vars ---
const REQUIRED_ENV = ['GEMINI_API_KEY'];

function validateEnv() {
    const missing = REQUIRED_ENV.filter(key => !process.env[key]);
    if (missing.length > 0) {
        logger.error('Config', `FATAL: Missing required environment variables: ${missing.join(', ')}`);
        logger.error('Config', 'Copy .env.example to .env and fill in the required values.');
        process.exit(1);
    }
}

validateEnv();

// --- Helper ---
function envInt(key, fallback) {
    const v = process.env[key];
    if (v === undefined) return fallback;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
}

const config = {
    // Bot identity (optional fallbacks — auto-detected from WhatsApp on connection)
    botName: process.env.BOT_NAME || 'Bot',
    botNumber: process.env.BOT_NUMBER || '',
    botUserId: process.env.BOT_USER_ID || '',

    // AI provider
    aiProvider: process.env.AI_PROVIDER || 'gemini',
    aiModel: process.env.AI_MODEL || 'gemini-2.5-pro',

    // Message history
    messageHistoryLimit: envInt('MESSAGE_HISTORY_LIMIT', 20),
    extendedMessageHistoryLimit: envInt('EXTENDED_HISTORY_LIMIT', 80),
    extendedHistoryCode: '#$',

    // TTS
    ttsTrigger: process.env.TTS_TRIGGER || '$aa',

    // Directories
    dataDirectory: process.env.DATA_DIRECTORY || 'data',
    imageDirectory: process.env.IMAGE_DIRECTORY || 'data/temp_images',
    audioDirectory: process.env.AUDIO_DIRECTORY || 'data/temp_audio',

    // Timing
    cooldownPeriod: envInt('COOLDOWN_PERIOD_MS', 2000),
    batchTimeout: envInt('BATCH_TIMEOUT_MS', 2000),

    // Background processor
    backgroundAiModel: process.env.BACKGROUND_AI_MODEL || 'gemini-3-flash-preview',
    backgroundDebounceMs: envInt('BACKGROUND_DEBOUNCE_MS', 300000),
    backgroundMessageThreshold: envInt('BACKGROUND_MESSAGE_THRESHOLD', 20),
    memoriesDirectory: process.env.MEMORIES_DIRECTORY || 'data/group_memories',

    // Admin panel
    adminPort: envInt('ADMIN_PORT', 3000),
    adminHost: process.env.ADMIN_HOST || '0.0.0.0',
    adminBasePath: process.env.ADMIN_BASE_PATH || '',
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
};

module.exports = config;
