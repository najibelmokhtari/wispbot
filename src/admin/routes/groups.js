const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const logger = require('../../logger');
const {
    getAllGroupInfo,
    getActiveGroups,
    getInactiveGroups,
    getOrCreateGroupInfo,
    updateGroupInfo,
    getUserNameById,
    isUserAuthorized,
    isUserAdmin: isUserBotAdmin,
    getBotSetting,
    getDatabase
} = require('../../db');
const { AVAILABLE_MODELS } = require('../../pricing-config');

const config = require('../../config');
const { parsePersonaFile, serializePersona } = require('../../persona-parser');

const PERSONAS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'personas');
const GROUP_CONTEXTS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'group_contexts');
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const MEMORIES_DIR = path.join(PROJECT_ROOT, config.memoriesDirectory);

// Helper: list available persona names from files
async function getPersonaNames() {
    const files = await fs.readdir(PERSONAS_DIR);
    const names = files
        .filter(f => f.endsWith('.persona') && f !== 'default.persona')
        .map(f => f.slice(0, -8))
        .sort();
    return ['default', ...names];
}

// Helper: read and parse a .persona file
async function readPersona(name) {
    const filePath = path.join(PERSONAS_DIR, `${name}.persona`);
    const raw = await fs.readFile(filePath, 'utf8');
    return parsePersonaFile(raw);
}

// Helper: read, update a field, and write back a .persona file
async function updatePersonaField(name, field, value) {
    let persona;
    try {
        persona = await readPersona(name);
    } catch {
        persona = { voice: '', systemPrompt: '', ttsStyle: '' };
    }
    persona[field] = value;
    await fs.writeFile(path.join(PERSONAS_DIR, `${name}.persona`), serializePersona(persona), 'utf8');
}

// Helper: validate and resolve group context path
function getContextPath(groupId) {
    if (!/^[\w@.\-]+$/.test(groupId)) return null;
    const resolved = path.resolve(GROUP_CONTEXTS_DIR, `${groupId}.txt`);
    if (!resolved.startsWith(path.resolve(GROUP_CONTEXTS_DIR))) return null;
    return resolved;
}

// Groups list page
router.get('/groups', async (req, res) => {
    try {
        const activeChats = await getActiveGroups();
        const inactiveChats = await getInactiveGroups();
        const personas = await getPersonaNames();

        const groups = [];
        const dms = [];
        const unconfiguredGroups = [];
        const unconfiguredDms = [];

        for (const chat of activeChats) {
            if (chat.group_id.endsWith('@g.us')) {
                groups.push(chat);
            } else {
                const contactName = await getUserNameById(chat.group_id);
                if (contactName) chat.resolved_name = contactName;
                dms.push(chat);
            }
        }

        for (const chat of inactiveChats) {
            if (chat.group_id.endsWith('@g.us')) {
                unconfiguredGroups.push(chat);
            } else {
                const contactName = await getUserNameById(chat.group_id);
                if (contactName) chat.resolved_name = contactName;
                unconfiguredDms.push(chat);
            }
        }

        res.render('groups', { groups, dms, unconfiguredGroups, unconfiguredDms, personas, models: AVAILABLE_MODELS });
    } catch (error) {
        logger.error('Admin', 'Error loading groups: ' + error.message);
        res.status(500).send('Error loading groups');
    }
});

// Group detail page
router.get('/groups/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const groupInfo = await getOrCreateGroupInfo(groupId, groupId);
        const personas = await getPersonaNames();

        // Load group context
        let context = '';
        const ctxPath = getContextPath(groupId);
        if (ctxPath) {
            try {
                context = await fs.readFile(ctxPath, 'utf8');
            } catch (e) {
                // No context file yet
            }
        }

        // Load group memories
        let memories = '';
        const memPath = getMemoriesPath(groupId);
        if (memPath) {
            try {
                memories = await fs.readFile(memPath, 'utf8');
            } catch (e) {
                // No memories file yet
            }
        }

        const defaultHistoryLimit = await getBotSetting('default_message_history_limit') || '20';
        const defaultDebounceSeconds = Math.round(config.backgroundDebounceMs / 1000);
        const defaultMessageThreshold = config.backgroundMessageThreshold;
        const backgroundGlobalEnabled = (await getBotSetting('background_processing_global')) === '1';
        const defaultAudioHistoryMode = await getBotSetting('default_audio_history_mode') || 'tagged';
        const defaultAudioHistoryCount = await getBotSetting('default_audio_history_count') || '1';
        const defaultAudioDurationCap = await getBotSetting('default_audio_duration_cap') || '900';
        const defaultTtsTriggerMode = await getBotSetting('default_tts_trigger_mode') || 'keyword';

        res.render('group-detail', {
            group: groupInfo,
            personas,
            models: AVAILABLE_MODELS,
            context,
            memories,
            defaultHistoryLimit,
            defaultDebounceSeconds,
            defaultMessageThreshold,
            backgroundGlobalEnabled,
            defaultAudioHistoryMode,
            defaultAudioHistoryCount,
            defaultAudioDurationCap,
            defaultTtsTriggerMode
        });
    } catch (error) {
        logger.error('Admin', 'Error loading group detail: ' + error.message);
        res.status(500).send('Error loading group');
    }
});

// API: update group settings
router.post('/api/groups/:groupId/settings', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const allowed = [
            'google_search_enabled', 'audio_enabled', 'tts_enabled',
            'authorization_check_enabled', 'ai_model', 'default_prompt_name',
            'group_name', 'background_processing_enabled',
            'background_debounce_ms', 'background_message_threshold',
            'custom_message_limit', 'audio_history_mode', 'audio_history_count',
            'audio_duration_cap', 'tts_trigger_mode'
        ];
        const updateData = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                updateData[key] = req.body[key];
            }
        }
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        await updateGroupInfo(groupId, updateData);
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error updating group settings: ' + error.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// API: get group context
router.get('/api/groups/:groupId/context', async (req, res) => {
    try {
        const ctxPath = getContextPath(req.params.groupId);
        if (!ctxPath) return res.status(400).json({ error: 'Invalid group ID' });
        let content = '';
        try {
            content = await fs.readFile(ctxPath, 'utf8');
        } catch (e) {
            // No file yet
        }
        res.json({ content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read context' });
    }
});

// API: save group context
router.post('/api/groups/:groupId/context', async (req, res) => {
    try {
        const ctxPath = getContextPath(req.params.groupId);
        if (!ctxPath) return res.status(400).json({ error: 'Invalid group ID' });
        await fs.mkdir(GROUP_CONTEXTS_DIR, { recursive: true });
        await fs.writeFile(ctxPath, req.body.content || '', 'utf8');
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving context: ' + error.message);
        res.status(500).json({ error: 'Failed to save context' });
    }
});

// Helper: validate and resolve group memories path
function getMemoriesPath(groupId) {
    if (!/^[\w@.\-]+$/.test(groupId)) return null;
    const resolved = path.resolve(MEMORIES_DIR, `${groupId}.md`);
    if (!resolved.startsWith(path.resolve(MEMORIES_DIR))) return null;
    return resolved;
}

// API: get group memories
router.get('/api/groups/:groupId/memories', async (req, res) => {
    try {
        const memPath = getMemoriesPath(req.params.groupId);
        if (!memPath) return res.status(400).json({ error: 'Invalid group ID' });
        let content = '';
        try {
            content = await fs.readFile(memPath, 'utf8');
        } catch (e) {
            // No memories file yet
        }
        res.json({ content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read memories' });
    }
});

// API: save group memories
router.post('/api/groups/:groupId/memories', async (req, res) => {
    try {
        const memPath = getMemoriesPath(req.params.groupId);
        if (!memPath) return res.status(400).json({ error: 'Invalid group ID' });
        await fs.mkdir(MEMORIES_DIR, { recursive: true });
        await fs.writeFile(memPath, req.body.content || '', 'utf8');
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving memories: ' + error.message);
        res.status(500).json({ error: 'Failed to save memories' });
    }
});

// API: list personas
router.get('/api/personas', async (req, res) => {
    try {
        const names = await getPersonaNames();
        res.json(names);
    } catch (error) {
        res.status(500).json({ error: 'Failed to list personas' });
    }
});

// API: get persona content
router.get('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        if (name === 'default') return res.json({ content: '' });
        const persona = await readPersona(name);
        res.json({ content: persona.systemPrompt });
    } catch (error) {
        res.status(404).json({ error: 'Persona not found' });
    }
});

// API: save persona content
router.post('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        if (name.length > 30) return res.status(400).json({ error: 'Persona name must be 30 characters or less' });
        if (name === 'default') return res.status(400).json({ error: 'Cannot edit the default persona (it uses base instructions only)' });
        await updatePersonaField(name, 'systemPrompt', req.body.content || '');
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving persona: ' + error.message);
        res.status(500).json({ error: 'Failed to save persona' });
    }
});

// API: delete persona
router.delete('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (name === 'default') return res.status(400).json({ error: 'Cannot delete the default persona' });
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await fs.unlink(path.join(PERSONAS_DIR, `${name}.persona`));
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Persona not found' });
        logger.error('Admin', 'Error deleting persona: ' + error.message);
        res.status(500).json({ error: 'Failed to delete persona' });
    }
});

// API: get persona TTS settings (voice + style prompt)
router.get('/api/personas/:name/tts', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        const persona = await readPersona(name);
        res.json({ voice: persona.voice, stylePrompt: persona.ttsStyle });
    } catch (error) {
        res.json({ voice: '', stylePrompt: '' });
    }
});

// API: save persona TTS voice
router.post('/api/personas/:name/tts/voice', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await updatePersonaField(name, 'voice', (req.body.voice || '').trim());

        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name === 'default' ? 'base' : name);
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', `Error saving persona TTS voice: ${error.message}`);
        res.status(500).json({ error: 'Failed to save TTS voice' });
    }
});

// API: save persona TTS style prompt
router.post('/api/personas/:name/tts/style', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await updatePersonaField(name, 'ttsStyle', req.body.content || '');

        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name === 'default' ? 'base' : name);
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', `Error saving persona TTS style: ${error.message}`);
        res.status(500).json({ error: 'Failed to save TTS style prompt' });
    }
});

// API: get group usage stats
router.get('/api/groups/:groupId/usage', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const period = req.query.period || '30d';

        let startDate;
        const now = new Date();
        if (period === '7d') {
            startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
        } else if (period === '30d') {
            startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
        } else {
            startDate = new Date('2000-01-01');
        }

        const db = await getDatabase();

        // Per-model totals
        const byModel = await db.all(`
            SELECT
                ai_model,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd
            FROM claude_api_calls
            WHERE group_id = ? AND timestamp >= ?
            GROUP BY ai_model
            ORDER BY cost_usd DESC
        `, [groupId, startDate.toISOString()]);

        // Per-user totals
        const byUser = await db.all(`
            SELECT
                user_id,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd
            FROM claude_api_calls
            WHERE group_id = ? AND timestamp >= ?
            GROUP BY user_id
            ORDER BY cost_usd DESC
        `, [groupId, startDate.toISOString()]);

        // Resolve user names
        for (const row of byUser) {
            const name = await getUserNameById(row.user_id);
            row.user_name = name || row.user_id.replace(/@c\.us$/, '');
        }

        // Grand totals
        const totals = {
            call_count: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0
        };
        for (const row of byModel) {
            totals.call_count += row.call_count || 0;
            totals.input_tokens += row.input_tokens || 0;
            totals.output_tokens += row.output_tokens || 0;
            totals.cached_tokens += row.cached_tokens || 0;
            totals.cost_usd += row.cost_usd || 0;
        }

        res.json({ byModel, byUser, totals });
    } catch (error) {
        logger.error('Admin', 'Error fetching group usage: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch usage data' });
    }
});

// API: activate a group (set is_active = 1)
router.post('/api/groups/:groupId/activate', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        await updateGroupInfo(groupId, { is_active: 1 });
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error activating group: ' + error.message);
        res.status(500).json({ error: 'Failed to activate group' });
    }
});

// API: deactivate a group (set is_active = 0)
router.post('/api/groups/:groupId/deactivate', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        await updateGroupInfo(groupId, { is_active: 0 });
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error deactivating group: ' + error.message);
        res.status(500).json({ error: 'Failed to deactivate group' });
    }
});

// API: get live WhatsApp info for a group
router.get('/api/groups/:groupId/whatsapp-info', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const client = req.sharedState?.whatsappClient;
        if (!client) {
            return res.status(503).json({ error: 'WhatsApp client not available' });
        }

        // Check if the client's browser page is still alive
        if (!client.pupPage || client.pupPage.isClosed()) {
            return res.status(503).json({ error: 'WhatsApp client session is not active. Try reconnecting.' });
        }

        const chat = await client.getChatById(groupId);
        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Group not found on WhatsApp' });
        }

        // Get participant details
        const participants = [];
        if (chat.participants) {
            for (const p of chat.participants) {
                let name = p.id._serialized;
                try {
                    const contact = await client.getContactById(p.id._serialized);
                    name = contact.pushname || contact.name || p.id._serialized;
                } catch (e) {
                    // Use raw ID if contact lookup fails
                }
                const authorized = await isUserAuthorized(p.id._serialized);
                const botAdmin = await isUserBotAdmin(p.id._serialized);
                const isBot = p.id._serialized === config.botUserId || p.id._serialized === config.botLidUserId;
                participants.push({
                    id: p.id._serialized,
                    name: name,
                    isAdmin: p.isAdmin || false,
                    isSuperAdmin: p.isSuperAdmin || false,
                    isAuthorized: authorized,
                    isBotAdmin: botAdmin,
                    isBot: isBot
                });
            }
        }

        // Also update the stored group name if it was the raw ID
        const groupInfo = await getOrCreateGroupInfo(groupId, chat.name || groupId);
        if (chat.name && groupInfo.group_name === groupInfo.group_id) {
            await updateGroupInfo(groupId, { group_name: chat.name });
        }

        res.json({
            name: chat.name || groupId,
            description: chat.description || '',
            participants: participants,
            participantCount: participants.length,
            createdAt: chat.createdAt ? new Date(chat.createdAt > 1e10 ? chat.createdAt : chat.createdAt * 1000).toISOString() : null
        });
    } catch (error) {
        logger.error('Admin', 'Error fetching WhatsApp info: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch WhatsApp info' });
    }
});

module.exports = router;
