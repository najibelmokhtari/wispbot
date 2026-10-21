require('dotenv').config();
const crypto = require('crypto');
const logger = require('./logger');

// --- Required env vars ---
const REQUIRED_ENV = ['GEMINI_API_KEY'];

function validateEnv() {
    const missing = REQUIRED_ENV.filter(key => !process.env[key]);
    if (missing.length > 0) {
        logger.warn('Config', `Missing environment variables: ${missing.join(', ')} — setup wizard will guide you through configuration.`);
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
    botName: process.env.BOT_NAME || 'Wispbot',
    botNumber: process.env.BOT_NUMBER || '',
    botUserId: process.env.BOT_USER_ID || '',

    // AI provider
    aiProvider: process.env.AI_PROVIDER || 'gemini',
    aiModel: process.env.AI_MODEL || 'gemini-4-argon',

    // Message history
    messageHistoryLimit: envInt('MESSAGE_HISTORY_LIMIT', 20),
    extendedMessageHistoryLimit: envInt('EXTENDED_HISTORY_LIMIT', 80),
    extendedHistoryCode: '#$',

    // TTS
    ttsTrigger: process.env.TTS_TRIGGER || '$audio',
    ttsProvider: process.env.TTS_PROVIDER || 'dev',       // 'dev' (Gemini API key) or 'vertex' (service account)
    ttsModel: process.env.TTS_MODEL || 'gemini-3.8-flash-tts',

    // Vertex AI (only needed when TTS_PROVIDER=vertex)
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    googleServiceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',  // Path to a key file; used when the JSON var is empty
    vertexRegion: process.env.VERTEX_REGION || 'us-central1',

    // Directories
    dataDirectory: process.env.DATA_DIRECTORY || 'data',
    imageDirectory: process.env.IMAGE_DIRECTORY || 'data/images',
    audioDirectory: process.env.AUDIO_DIRECTORY || 'data/audio',

    // Timing
    cooldownPeriod: envInt('COOLDOWN_PERIOD_MS', 2000),
    batchTimeout: envInt('BATCH_TIMEOUT_MS', 2000),

    // Background processor (Memories)
    backgroundAiModel: process.env.BACKGROUND_AI_MODEL || 'gemini-3-flash-preview',
    backgroundDebounceMs: envInt('BACKGROUND_DEBOUNCE_MS', 300000),
    backgroundMessageThreshold: envInt('BACKGROUND_MESSAGE_THRESHOLD', 20),
    memoriesDirectory: process.env.MEMORIES_DIRECTORY || 'data/group_memories',

    // Active Listening
    activeListeningAiModel: process.env.ACTIVE_LISTENING_AI_MODEL || 'gemini-3-flash-preview',
    activeListeningThrottleMs: envInt('ACTIVE_LISTENING_THROTTLE_MS', 10000),
    activeListeningContextCount: envInt('ACTIVE_LISTENING_CONTEXT_COUNT', 15),

    // Admin panel
    adminPort: envInt('ADMIN_PORT', 3000),
    adminHost: process.env.ADMIN_HOST || '127.0.0.1',
    adminBasePath: process.env.ADMIN_BASE_PATH || '',
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

    // Community personas
    communityPersonasRepo: process.env.COMMUNITY_PERSONAS_REPO || 'najibelmokhtari/wispbot-personas',
    communityPersonasToken: process.env.COMMUNITY_PERSONAS_TOKEN || '',

    // WhatsApp session (Baileys)
    authSessionPath: process.env.AUTH_SESSION_PATH || './auth_session',
};

module.exports = config;
