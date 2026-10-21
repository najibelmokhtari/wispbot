const { register, commands } = require('./index');
const { isUserAdmin, getOrCreateGroupInfo, getBotSetting } = require('../db');
const logger = require('../logger');

const commandDescriptions = {
    '!ping': 'Check if I\'m alive',
    '!clear': 'Reset my conversation memory',
    '!usage': 'View your API usage stats',
    '!stop': 'Shut me down in this chat',
    '!start': 'Bring me back after a !stop',
    '!help': 'Show this help message',
    '!addme': 'Request access to use me (groups only)',
    '!persona': 'Switch persona (e.g. !persona casawi)',
};

async function handler(client, message, config) {
    try {
        const senderId = message.author || message.from;
        const chatId = message.from;
        const isGroup = chatId.endsWith('@g.us');
        const isAdmin = await isUserAdmin(senderId);

        const botName = config.botName || 'Bot';
        let response = `Hey! I'm *${botName}*. Here's how I work:\n\n`;

        // --- How to talk to me ---
        if (isGroup) {
            const groupInfo = await getOrCreateGroupInfo(chatId);
            const activeListening = groupInfo.active_listening_enabled === 1;

            if (activeListening) {
                response += `*Talking to me:* I'm actively listening in this group — I'll chime in when I think I can help. You can also mention or reply to me directly.\n\n`;
            } else {
                response += `*Talking to me:* Mention me by name or reply to one of my messages and I'll respond.\n\n`;
            }

            // --- Features ---
            const features = [];
            if (groupInfo.google_search_enabled) features.push('web search');
            if (groupInfo.audio_enabled) features.push('voice messages');
            if (groupInfo.image_enabled) features.push('images');

            if (features.length > 0) {
                response += `*I can process:* ${features.join(', ')}.\n`;
            }

            // --- TTS ---
            if (groupInfo.tts_enabled) {
                const triggerMode = groupInfo.tts_trigger_mode || await getBotSetting('default_tts_trigger_mode') || 'tag';
                if (triggerMode === 'always') {
                    response += `*Voice replies:* I'll reply with audio by default.\n`;
                } else if (triggerMode === 'auto') {
                    const ttsTrigger = await getBotSetting('tts_trigger') || config.ttsTrigger || '$audio';
                    response += `*Voice replies:* I'll send a voice note when it fits the moment. Include *${ttsTrigger}* to always get one.\n`;
                } else {
                    const ttsTrigger = await getBotSetting('tts_trigger') || config.ttsTrigger || '$audio';
                    response += `*Voice replies:* Include *${ttsTrigger}* in your message and I'll reply with audio.\n`;
                }
            }

            response += '\n';

            // --- Authorization ---
            if (groupInfo.authorization_check_enabled) {
                response += `_This group requires authorization. Use *!addme* if you haven't been approved yet._\n\n`;
            }
        } else {
            response += `*Talking to me:* Just send me a message — I'll reply to everything here.\n\n`;
        }

        // --- Bot status ---
        const botActive = await getBotSetting('bot_active');
        if (botActive === '0') {
            response += `⚠️ *I'm currently offline.* I won't respond to messages right now. If you're an admin, check the admin panel or use *!start* to bring me back.\n\n`;
        }

        // --- Commands ---
        response += `*Commands:*\n`;
        for (const [name, { adminOnly }] of commands) {
            if (adminOnly && !isAdmin) continue;
            const desc = commandDescriptions[name] || '';
            const tag = adminOnly ? ' _(admin)_' : '';
            response += `  ${name}${tag} — ${desc}\n`;
        }
        await client.sendMessage(chatId, response);
    } catch (error) {
        logger.error('Cmd', 'Error showing help: ' + error.message);
    }
}

register('!help', handler, { adminOnly: false, public: true });
