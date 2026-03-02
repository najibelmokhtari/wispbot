const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const logger = require('../../logger');
const { getBotSetting, setBotSetting } = require('../../db');
const { parsePersonaFile } = require('../../persona-parser');

const ENV_PATH = path.resolve(__dirname, '../../../.env');

// --- Middleware: only allow access when setup is incomplete ---
async function requireSetupIncomplete(req, res, next) {
    try {
        const setupComplete = await getBotSetting('setup_complete');
        if (setupComplete === '1') {
            // Setup already done — redirect to login
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ error: 'Setup already completed' });
            }
            return res.redirect(req.baseUrl + '/login');
        }
        next();
    } catch (err) {
        logger.error('Setup', 'Error checking setup state: ' + err.message);
        next(); // allow through on DB error so wizard can still load
    }
}

// --- Helper: read/write .env file ---
function readEnvFile() {
    try {
        return fs.readFileSync(ENV_PATH, 'utf8');
    } catch {
        return '';
    }
}

function sanitizeEnvValue(value) {
    // Strip newlines, carriage returns, and null bytes to prevent .env injection
    return String(value).replace(/[\r\n\0]/g, '');
}

function writeEnvVars(vars) {
    let content = readEnvFile();
    for (const [key, value] of Object.entries(vars)) {
        const sanitized = sanitizeEnvValue(value);
        const regex = new RegExp(`^${key}=.*$`, 'm');
        const line = `${key}=${sanitized}`;
        if (regex.test(content)) {
            content = content.replace(regex, line);
        } else {
            content = content.trimEnd() + '\n' + line + '\n';
        }
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    // Also update process.env so the running process sees it immediately
    for (const [key, value] of Object.entries(vars)) {
        process.env[key] = sanitizeEnvValue(value);
    }
}

// --- Wizard page ---
router.get('/setup', requireSetupIncomplete, (req, res) => {
    res.render('setup');
});

// --- API: validate Gemini API key ---
router.post('/api/setup/validate-key', requireSetupIncomplete, async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) {
        return res.json({ valid: false, error: 'API key is required' });
    }
    try {
        // Use the list models endpoint — free, no quota consumed, no rate limits
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`
        );
        if (response.ok) {
            res.json({ valid: true });
        } else {
            const data = await response.json().catch(() => ({}));
            const status = response.status;
            if (status === 400 || status === 403) {
                res.json({ valid: false, error: 'Invalid API key. Please check and try again.' });
            } else {
                res.json({ valid: false, error: data.error?.message || `API returned status ${status}. Please try again.` });
            }
        }
    } catch (err) {
        logger.warn('Setup', 'API key validation failed: ' + err.message);
        res.json({ valid: false, error: 'Could not reach the Gemini API. Check your internet connection.' });
    }
});

// --- API: save credentials to .env ---
router.post('/api/setup/save-credentials', requireSetupIncomplete, async (req, res) => {
    const { apiKey, adminPassword } = req.body;
    if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ error: 'API key is required' });
    }
    if (!adminPassword || adminPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        // Write to .env
        writeEnvVars({
            GEMINI_API_KEY: apiKey.trim(),
            ADMIN_PASSWORD: adminPassword
        });

        // Re-initialize Gemini client with the new key
        const { reinitializeGemini } = require('../../ai/gemini');
        reinitializeGemini(apiKey.trim());

        // Authenticate the current session so they can use connection endpoints
        req.session.authenticated = true;

        // Start WhatsApp connection immediately so QR code is ready when the wizard advances
        try {
            const botModule = require('../../bot');
            const state = botModule.getConnectionState();
            if (state.status === 'waiting') {
                logger.info('Setup', 'Starting WhatsApp connection after credentials saved...');
                botModule.startSocket();
            }
        } catch (e) {
            logger.warn('Setup', 'Could not auto-start connection: ' + e.message);
        }

        res.json({ ok: true });
    } catch (err) {
        logger.error('Setup', 'Error saving credentials: ' + err.message);
        res.status(500).json({ error: 'Failed to save credentials: ' + err.message });
    }
});

// --- API: save wizard settings to DB ---
router.post('/api/setup/save-settings', requireSetupIncomplete, async (req, res) => {
    const { botName, persona, activeListening, memories, spendingLimit, spendingMode, ttsTrigger } = req.body;

    try {
        if (botName) {
            await setBotSetting('bot_name', botName);
            // Also write BOT_NAME to .env for config.js
            writeEnvVars({ BOT_NAME: botName });
        }
        if (persona) {
            await setBotSetting('default_persona', persona);
        }
        if (activeListening !== undefined) {
            await setBotSetting('default_active_listening', activeListening ? '1' : '0');
        }
        if (memories !== undefined) {
            await setBotSetting('background_processing_global', memories ? '1' : '0');
            await setBotSetting('default_background_processing', memories ? '1' : '0');
        }
        if (ttsTrigger) {
            writeEnvVars({ TTS_TRIGGER: ttsTrigger });
        }
        if (spendingLimit !== undefined && spendingLimit !== null) {
            const val = parseFloat(spendingLimit);
            if (!isNaN(val) && val > 0) {
                await setBotSetting('usage_hard_limit', String(val));
                await setBotSetting('usage_cap_mode', spendingMode === 'manual' ? 'manual' : 'monthly');
                await setBotSetting('usage_limit_reset_date', new Date().toISOString());
            }
        }
        res.json({ ok: true });
    } catch (err) {
        logger.error('Setup', 'Error saving settings: ' + err.message);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// --- API: mark setup as complete + seed defaults ---
router.post('/api/setup/complete', requireSetupIncomplete, async (req, res) => {
    try {
        // Seed sensible defaults for any settings not already configured
        const defaults = {
            bot_active: '1',
            default_persona: 'default',
            default_ai_model: 'gemini-3.1-pro-preview',
            default_google_search: '1',
            default_audio: '1',
            default_image: '1',
            default_tts: '1',
            default_auth_check: '0',
            default_active_listening: '0',
            default_background_processing: '0',
            background_processing_global: '0',
            bot_activation_mode: 'all',
        };

        for (const [key, value] of Object.entries(defaults)) {
            const existing = await getBotSetting(key);
            if (existing === null) {
                await setBotSetting(key, value);
            }
        }

        await setBotSetting('setup_complete', '1');
        logger.info('Setup', 'Setup wizard completed successfully');
        res.json({ ok: true });
    } catch (err) {
        logger.error('Setup', 'Error completing setup: ' + err.message);
        res.status(500).json({ error: 'Failed to complete setup' });
    }
});

// --- API: list available personas ---
router.get('/api/setup/personas', requireSetupIncomplete, async (req, res) => {
    try {
        const personasDir = path.resolve(__dirname, '../../../prompts/personas');
        const files = await fsPromises.readdir(personasDir);
        const personas = [];

        for (const file of files) {
            if (!file.endsWith('.persona')) continue;
            const name = file.replace('.persona', '');
            const content = await fsPromises.readFile(path.join(personasDir, file), 'utf8');
            const parsed = parsePersonaFile(content);
            personas.push({
                name,
                description: parsed.meta.description || '',
                tags: parsed.meta.tags || [],
                // Grab first ~100 chars of system prompt as a preview
                preview: parsed.systemPrompt ? parsed.systemPrompt.substring(0, 100) + '...' : ''
            });
        }

        // Sort: default first, then alphabetical
        personas.sort((a, b) => {
            if (a.name === 'default') return -1;
            if (b.name === 'default') return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ personas });
    } catch (err) {
        logger.error('Setup', 'Error listing personas: ' + err.message);
        res.json({ personas: [{ name: 'default', description: 'Default personality', tags: [], preview: '' }] });
    }
});

// --- API: ensure WhatsApp connection is started (for wizard resume) ---
router.post('/api/setup/ensure-connection', requireSetupIncomplete, async (req, res) => {
    try {
        const botModule = require('../../bot');
        const state = botModule.getConnectionState();
        if (state.status === 'waiting' && process.env.GEMINI_API_KEY) {
            logger.info('Setup', 'Starting WhatsApp connection (wizard resume)...');
            botModule.startSocket();
        }
        res.json({ ok: true, status: state.status });
    } catch (e) {
        logger.warn('Setup', 'Could not start connection: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- API: wizard progress (so it can resume where the user left off) ---
router.get('/api/setup/progress', requireSetupIncomplete, async (req, res) => {
    try {
        const hasApiKey = !!process.env.GEMINI_API_KEY;
        const hasPassword = !!process.env.ADMIN_PASSWORD;
        const botName = await getBotSetting('bot_name');
        const persona = await getBotSetting('default_persona');
        const botNumber = await getBotSetting('bot_number');

        // Determine the first incomplete step
        // Steps: 0=Welcome, 1=API Key, 2=Password, 3=WhatsApp QR, 4=Bot Name, 5=Personality, 6=Bot Trigger, 7=Memory, 8=Spending, 9=Summary
        let resumeStep = 0;
        if (hasApiKey) resumeStep = 2;           // skip API key step
        if (hasApiKey && hasPassword) resumeStep = 3;  // skip password step
        if (hasApiKey && hasPassword && botNumber) resumeStep = 4; // skip QR step
        // Don't auto-skip beyond QR — user should confirm name/personality/engagement even if DB has values

        res.json({
            resumeStep,
            hasApiKey,
            hasPassword,
            hasConnection: !!botNumber,
            botName: botName || '',
            persona: persona || 'default'
        });
    } catch (err) {
        res.json({ resumeStep: 0 });
    }
});

// --- API: check setup status ---
router.get('/api/setup/status', async (req, res) => {
    try {
        const setupComplete = await getBotSetting('setup_complete');
        res.json({ setupComplete: setupComplete === '1' });
    } catch (err) {
        res.json({ setupComplete: false });
    }
});

module.exports = { router: router, requireSetupIncomplete };
