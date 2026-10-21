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
    getDatabase,
    getConversationMessages,
    getConversationCount
} = require('../../db');
const { AVAILABLE_MODELS } = require('../../pricing-config');

const config = require('../../config');

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

// Helper: validate and resolve group context path
function getContextPath(groupId) {
    if (!/^[\w@.\-]+$/.test(groupId)) return null;
    const resolved = path.resolve(GROUP_CONTEXTS_DIR, `${groupId}.txt`);
    if (!resolved.startsWith(path.resolve(GROUP_CONTEXTS_DIR))) return null;
    return resolved;
}

// API: list current group/DM IDs (for polling new-chat detection)
router.get('/api/groups/ids', async (req, res) => {
    try {
        const active = await getActiveGroups();
        const inactive = await getInactiveGroups();
        const ids = [...active, ...inactive].map(g => g.group_id);
        res.json({ ids });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch group IDs' });
    }
});

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

        const backgroundGlobalEnabled = (await getBotSetting('background_processing_global')) === '1';

        res.render('groups', { groups, dms, unconfiguredGroups, unconfiguredDms, personas, models: AVAILABLE_MODELS, backgroundGlobalEnabled });
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
        const defaultActiveListeningThrottle = await getBotSetting('default_active_listening_throttle_ms') || String(config.activeListeningThrottleMs);
        const defaultActiveListeningContextCount = await getBotSetting('default_active_listening_context_count') || String(config.activeListeningContextCount);
        const defaultAlSendAudio = await getBotSetting('default_al_send_audio') || '0';
        const defaultAlSendImages = await getBotSetting('default_al_send_images') || '0';
        const defaultAlAudioCount = await getBotSetting('default_al_audio_count') || '3';
        const defaultAlImageCount = await getBotSetting('default_al_image_count') || '3';
        const defaultAudioHistoryMode = await getBotSetting('default_audio_history_mode') || 'tagged';
        const defaultAudioHistoryCount = await getBotSetting('default_audio_history_count') || '1';
        const defaultAudioDurationCap = await getBotSetting('default_audio_duration_cap') || '900';
        const defaultImageHistoryMode = await getBotSetting('default_image_history_mode') || 'tagged';
        const defaultImageHistoryCount = await getBotSetting('default_image_history_count') || '1';
        const defaultTtsTriggerMode = await getBotSetting('default_tts_trigger_mode') || 'tag';
        const ttsTrigger = await getBotSetting('tts_trigger') || '$audio';

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
            defaultActiveListeningThrottle: Math.round(parseInt(defaultActiveListeningThrottle) / 1000),
            defaultActiveListeningContextCount,
            defaultAlSendAudio,
            defaultAlSendImages,
            defaultAlAudioCount,
            defaultAlImageCount,
            defaultAudioHistoryMode,
            defaultAudioHistoryCount,
            defaultAudioDurationCap,
            defaultAudioPreviewSeconds: config.audioPreviewSeconds,
            defaultImageHistoryMode,
            defaultImageHistoryCount,
            defaultTtsTriggerMode,
            ttsTrigger
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
            'google_search_enabled', 'audio_enabled', 'image_enabled', 'tts_enabled',
            'authorization_check_enabled', 'ai_model', 'default_prompt_name',
            'group_name', 'background_processing_enabled',
            'background_debounce_ms', 'background_message_threshold',
            'custom_message_limit', 'audio_history_mode', 'audio_history_count',
            'audio_duration_cap', 'image_history_mode', 'image_history_count',
            'audio_preview_enabled', 'audio_preview_seconds',
            'tts_trigger_mode', 'tts_auto_instructions',
            'active_listening_enabled', 'active_listening_throttle_ms',
            'active_listening_context_count', 'active_listening_prompt',
            'active_listening_send_audio', 'active_listening_send_images',
            'active_listening_audio_count', 'active_listening_image_count'
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

        // Check if persona is being switched — read old value before updating
        let oldPersona = null;
        if (updateData.default_prompt_name) {
            const groupInfo = await getOrCreateGroupInfo(groupId, groupId);
            oldPersona = groupInfo.default_prompt_name || 'default';
        }

        await updateGroupInfo(groupId, updateData);

        // Announce persona switch to the group
        if (updateData.default_prompt_name && oldPersona !== updateData.default_prompt_name) {
            const client = req.sharedState?.whatsappClient;
            if (client) {
                const newPersona = updateData.default_prompt_name;
                try {
                    await client.sendMessage(groupId, `Persona switched from *${oldPersona}* to *${newPersona}* (via portal).`);
                } catch (e) {
                    logger.warn('Admin', `Failed to announce persona switch in ${groupId}: ${e.message}`);
                }
            }
        }

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

// API: get group usage stats
router.get('/api/groups/:groupId/usage', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const period = req.query.period || '30d';

        // Format date as 'YYYY-MM-DD HH:MM:SS' to match SQLite's CURRENT_TIMESTAMP format
        function toSqliteDate(d) {
            return d.getUTCFullYear() + '-' +
                String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                String(d.getUTCDate()).padStart(2, '0') + ' ' +
                String(d.getUTCHours()).padStart(2, '0') + ':' +
                String(d.getUTCMinutes()).padStart(2, '0') + ':' +
                String(d.getUTCSeconds()).padStart(2, '0');
        }

        let startDateStr;
        const now = new Date();
        if (period === '7d') {
            startDateStr = toSqliteDate(new Date(now - 7 * 24 * 60 * 60 * 1000));
        } else if (period === '30d') {
            startDateStr = toSqliteDate(new Date(now - 30 * 24 * 60 * 60 * 1000));
        } else if (period === 'since_reset') {
            const groupInfo = await getOrCreateGroupInfo(groupId, '');
            startDateStr = groupInfo.usage_reset_date
                ? toSqliteDate(new Date(groupInfo.usage_reset_date))
                : '2000-01-01 00:00:00';
        } else {
            startDateStr = '2000-01-01 00:00:00';
        }

        const db = await getDatabase();

        // Per-model totals (including TTS cost breakdown)
        const byModel = await db.all(`
            SELECT
                ai_model,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd,
                SUM(COALESCE(tts_cost_usd, 0)) as tts_cost_usd
            FROM llm_api_calls
            WHERE group_id = ? AND timestamp >= ?
            GROUP BY ai_model
            ORDER BY cost_usd DESC
        `, [groupId, startDateStr]);

        // Per-user totals
        const byUser = await db.all(`
            SELECT
                user_id,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd,
                SUM(COALESCE(tts_cost_usd, 0)) as tts_cost_usd
            FROM llm_api_calls
            WHERE group_id = ? AND timestamp >= ?
            GROUP BY user_id
            ORDER BY cost_usd DESC
        `, [groupId, startDateStr]);

        // Resolve user names
        for (const row of byUser) {
            if (row.user_id === 'background-processor') {
                row.user_name = 'Background Processing';
            } else {
                const name = await getUserNameById(row.user_id);
                row.user_name = name || row.user_id.replace(/@c\.us$/, '');
            }
        }

        // Grand totals
        const totals = {
            call_count: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0, tts_cost_usd: 0
        };
        for (const row of byModel) {
            totals.call_count += row.call_count || 0;
            totals.input_tokens += row.input_tokens || 0;
            totals.output_tokens += row.output_tokens || 0;
            totals.cached_tokens += row.cached_tokens || 0;
            totals.cost_usd += row.cost_usd || 0;
            totals.tts_cost_usd += row.tts_cost_usd || 0;
        }

        // Get reset date for the UI
        const groupInfo = await getOrCreateGroupInfo(groupId, '');
        const resetDate = groupInfo.usage_reset_date || null;

        res.json({ byModel, byUser, totals, resetDate });
    } catch (error) {
        logger.error('Admin', 'Error fetching group usage: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch usage data' });
    }
});

// API: reset usage counter for a group
router.post('/api/groups/:groupId/usage/reset', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        // Store in SQLite CURRENT_TIMESTAMP format for consistent comparisons
        const now = new Date();
        const resetDate = now.getUTCFullYear() + '-' +
            String(now.getUTCMonth() + 1).padStart(2, '0') + '-' +
            String(now.getUTCDate()).padStart(2, '0') + ' ' +
            String(now.getUTCHours()).padStart(2, '0') + ':' +
            String(now.getUTCMinutes()).padStart(2, '0') + ':' +
            String(now.getUTCSeconds()).padStart(2, '0');
        await updateGroupInfo(groupId, { usage_reset_date: resetDate });
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error resetting usage counter: ' + error.message);
        res.status(500).json({ error: 'Failed to reset usage counter' });
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

        // Use getChatById from the adapter (which calls sock.groupMetadata)
        let chat;
        try {
            chat = await client.getChatById(groupId);
        } catch (e) {
            return res.status(503).json({ error: 'WhatsApp client session is not active. Try reconnecting.' });
        }

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Group not found on WhatsApp' });
        }

        // Get participant details
        const resolveLid = req.sharedState?.resolveLid || ((jid) => jid);
        const participants = [];
        if (chat.participants) {
            for (const p of chat.participants) {
                const rawId = p.id._serialized;
                // Resolve LID to phone number if mapping exists
                const pId = resolveLid(rawId);
                const phoneNumber = pId.split('@')[0];
                // Try to get profile name from DB
                let profileName = null;
                try {
                    profileName = await getUserNameById(pId);
                    if (!profileName && rawId !== pId) {
                        profileName = await getUserNameById(rawId);
                    }
                } catch (e) {
                    // No profile name available
                }
                const authorized = await isUserAuthorized(pId) || (rawId !== pId && await isUserAuthorized(rawId));
                const botAdmin = await isUserBotAdmin(pId) || (rawId !== pId && await isUserBotAdmin(rawId));
                const isBot = pId === config.botUserId || rawId === config.botUserId;
                participants.push({
                    id: pId,
                    name: profileName || null,
                    phone: phoneNumber,
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

// Chat viewer page
router.get('/groups/:groupId/chat', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const groupInfo = await getOrCreateGroupInfo(groupId, groupId);
        const groupName = groupInfo.group_name || groupId;
        res.render('chat-viewer', { groupId, groupName, botName: config.botName, botUserId: config.botUserId });
    } catch (error) {
        logger.error('Admin', 'Error loading chat viewer: ' + error.message);
        res.status(500).send('Error loading chat viewer');
    }
});

// API: get conversation messages (paginated)
router.get('/api/groups/:groupId/messages', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;
        const messages = await getConversationMessages(groupId, limit, offset);
        const total = await getConversationCount(groupId);
        res.json({ messages, total });
    } catch (error) {
        logger.error('Admin', 'Error fetching messages: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

module.exports = router;
