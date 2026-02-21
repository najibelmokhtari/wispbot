const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo, getBotSetting } = require('../db');
const config = require('../config');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    const parts = message.body.split(' ');
    const state = parts[1] ? parts[1].toLowerCase() : null;

    if (state !== 'on' && state !== 'off') {
        const groupInfo = await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');
        const currentStatus = groupInfo.tts_enabled ? 'ON' : 'OFF';
        await client.sendMessage(message.from, `TTS (Text-to-Speech) is currently ${currentStatus}. Use '!tts on' or '!tts off' to change.`);
        return;
    }

    const enabled = state === 'on' ? 1 : 0;
    try {
        await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');

        await updateGroupInfo(message.from, { tts_enabled: enabled });
        const ttsTrigger = (await getBotSetting('tts_trigger')) || config.ttsTrigger;
        const response = `TTS feature has been turned ${state.toUpperCase()}. Authorized users can now include '${ttsTrigger}' in their message to receive an audio response.`;

        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });
        logger.info('Cmd', `Updated TTS preference for chat ${message.from} to ${state}`);
    } catch (error) {
        logger.error('Cmd', 'Error updating TTS preference: ' + error.message);
        await client.sendMessage(message.from, 'Error updating TTS preference.');
    }
}

register('!tts', handler);
