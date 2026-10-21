const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const logger = require('../../logger');
const { getAllBotSettings, getBotSetting, setBotSetting } = require('../../db');
const { AVAILABLE_MODELS } = require('../../pricing-config');
const { addPhoneToUsernameMapping } = require('../../phone-number-replacer');

const PERSONAS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'personas');
const SYSTEM_PROMPTS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'system');

// Editable system prompt blocks
const SYSTEM_PROMPTS = [
    { file: 'base_instructions.txt', name: 'base_instructions', displayName: 'Base Instructions', description: 'Prepended to every persona. Defines core bot behavior.' },
    { file: 'user_prefix_prompt.txt', name: 'user_prefix_prompt', displayName: 'User Prefix Prompt', description: 'Prefixed to the user message in API calls.' },
    { file: 'mention_instruction.txt', name: 'mention_instruction', displayName: 'Mention Instruction', description: 'Injected when the group has @-taggable users.' },
    { file: 'tts_system_instruction.txt', name: 'tts_system_instruction', displayName: 'TTS System Instruction', description: 'Format instructions for audio output mode.' },
    { file: 'tts_auto_instruction.txt', name: 'tts_auto_instruction', displayName: 'TTS Auto Mode Instruction', description: 'Tells the AI how to decide between a text and a voice reply in "Let AI decide" trigger mode.' },
    { file: 'background_memories_instruction.txt', name: 'background_memories_instruction', displayName: 'Memories: Extraction Prompt', description: 'System prompt for the background LLM that maintains group memories.' },
    { file: 'active_listening_instruction.txt', name: 'active_listening_instruction', displayName: 'Active Listening: Decision Prompt', description: 'System prompt for the fast LLM that decides whether the bot should respond.' },
];

const SYSTEM_PROMPT_NAMES = new Set(SYSTEM_PROMPTS.map(p => p.name));

// Helper: list available persona names from files
async function getPersonaNames() {
    const files = await fs.readdir(PERSONAS_DIR);
    const names = files
        .filter(f => f.endsWith('.persona') && f !== 'default.persona')
        .map(f => f.slice(0, -8))
        .sort();
    return ['default', ...names];
}

// Settings page
router.get('/settings', async (req, res) => {
    try {
        const settings = await getAllBotSettings();
        const personas = await getPersonaNames();
        res.render('settings', { settings, personas, models: AVAILABLE_MODELS, systemPrompts: SYSTEM_PROMPTS });
    } catch (error) {
        logger.error('Admin', 'Error loading settings page: ' + error.message);
        res.status(500).send('Failed to load settings');
    }
});

// API: get all settings
router.get('/api/settings', async (req, res) => {
    try {
        const settings = await getAllBotSettings();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read settings' });
    }
});

// API: update settings
router.post('/api/settings', async (req, res) => {
    try {
        const allowed = [
            'bot_name', 'bot_active', 'tts_trigger', 'default_persona', 'default_ai_model',
            'default_google_search', 'default_audio', 'default_image', 'default_tts', 'default_auth_check',
            'default_background_processing', 'default_background_debounce_ms', 'default_background_message_threshold',
            'background_processing_global', 'background_ai_model',
            'default_message_history_limit',
            'default_audio_history_mode', 'default_audio_history_count', 'default_audio_duration_cap',
            'default_image_history_mode', 'default_image_history_count',
            'default_tts_trigger_mode',
            'active_listening_ai_model',
            'default_active_listening', 'default_active_listening_throttle_ms', 'default_active_listening_context_count',
            'default_al_send_audio', 'default_al_send_images', 'default_al_audio_count', 'default_al_image_count',
            'offline_message_mode', 'bot_activation_mode', 'error_reporting_mode',
            'usage_hard_limit', 'usage_limit_reset_date', 'usage_cap_mode'
        ];
        for (const [key, value] of Object.entries(req.body)) {
            if (allowed.includes(key)) {
                await setBotSetting(key, String(value));
            }
        }
        // If bot_name changed, validate, update live config, and sync to WhatsApp
        if (req.body.bot_name !== undefined) {
            const name = req.body.bot_name.trim();
            // WhatsApp pushname limits: 1-25 chars, no control characters
            if (!name || name.length > 25) {
                return res.status(400).json({ error: 'Bot name must be 1-25 characters' });
            }
            // eslint-disable-next-line no-control-regex
            if (/[\x00-\x1f\x7f]/.test(name)) {
                return res.status(400).json({ error: 'Bot name cannot contain control characters' });
            }
            const config = req.botConfig;
            config.botName = name;
            if (config.botUserId) {
                addPhoneToUsernameMapping(config.botUserId, config.botName);
            }
            // Sync display name to WhatsApp profile
            const client = req.sharedState?.whatsappClient;
            if (client) {
                try {
                    const success = await client.setDisplayName(name);
                    if (success) {
                        logger.info('Admin', `WhatsApp display name updated to "${name}"`);
                        await setBotSetting('bot_pushname', name);
                    } else {
                        logger.warn('Admin', 'WhatsApp did not allow setting display name');
                    }
                } catch (err) {
                    logger.warn('Admin', `Failed to sync display name to WhatsApp: ${err.message}`);
                }
            }
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error updating settings: ' + error.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// API: get a system prompt file
router.get('/api/system-prompts/:name', async (req, res) => {
    const { name } = req.params;
    if (!SYSTEM_PROMPT_NAMES.has(name)) {
        return res.status(400).json({ error: 'Invalid system prompt name' });
    }
    const file = SYSTEM_PROMPTS.find(p => p.name === name).file;
    try {
        const content = await fs.readFile(path.join(SYSTEM_PROMPTS_DIR, file), 'utf-8');
        res.json({ content });
    } catch (error) {
        res.json({ content: '' });
    }
});

// API: save a system prompt file
router.post('/api/system-prompts/:name', async (req, res) => {
    const { name } = req.params;
    if (!SYSTEM_PROMPT_NAMES.has(name)) {
        return res.status(400).json({ error: 'Invalid system prompt name' });
    }
    const { content } = req.body;
    if (content === undefined) {
        return res.status(400).json({ error: 'Content is required' });
    }
    const file = SYSTEM_PROMPTS.find(p => p.name === name).file;
    try {
        await fs.writeFile(path.join(SYSTEM_PROMPTS_DIR, file), content, 'utf-8');
        // Reload base instructions in the live PromptManager if applicable
        if (name === 'base_instructions' && req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt('base');
        }
        logger.info('Admin', `System prompt '${name}' updated`);
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', `Error saving system prompt '${name}': ${error.message}`);
        res.status(500).json({ error: 'Failed to save system prompt' });
    }
});

module.exports = router;
