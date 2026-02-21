const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    const parts = message.body.split(' ');
    const state = parts[1] ? parts[1].toLowerCase() : null;

    if (state !== 'on' && state !== 'off') {
        const groupInfo = await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');
        const currentStatus = groupInfo.audio_enabled ? 'ON' : 'OFF';
        await client.sendMessage(message.from, `Audio processing is currently ${currentStatus}. Use '!audio on' or '!audio off' to change.`);
        return;
    }

    const enabled = state === 'on' ? 1 : 0;
    try {
        await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');

        await updateGroupInfo(message.from, { audio_enabled: enabled });
        const response = `Audio processing has been turned ${state.toUpperCase()}.`;

        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null,
            audioId: null
        });
        logger.info('Cmd', `Updated audio preference for chat ${message.from} to ${state}`);
    } catch (error) {
        logger.error('Cmd', 'Error updating audio preference: ' + error.message);
        await client.sendMessage(message.from, 'Error updating audio preference.');
    }
}

register('!audio', handler);
