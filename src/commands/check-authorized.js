const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    const parts = message.body.split(' ');
    const state = parts[1] ? parts[1].toLowerCase() : null;

    if (state !== 'on' && state !== 'off') {
        const groupInfo = await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');
        const currentStatus = groupInfo.authorization_check_enabled ? 'ON' : 'OFF';
        await client.sendMessage(message.from, `Authorization checking is currently ${currentStatus}. Use '!checkauthorized on' or '!checkauthorized off' to change.\n\nWhen OFF, any member of the group can invoke the bot without being in the authorized users list.`);
        return;
    }

    const enabled = state === 'on' ? 1 : 0;
    try {
        await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');

        await updateGroupInfo(message.from, { authorization_check_enabled: enabled });
        const response = `Authorization checking has been turned ${state.toUpperCase()}.${enabled ? '' : '\n\n⚠️ Warning: ANY member of this group can now invoke the bot and consume API credits.'}`;

        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null,
            audioId: null
        });
        logger.info('Cmd', `Updated authorization check setting for chat ${message.from} to ${state}`);
    } catch (error) {
        logger.error('Cmd', 'Error updating authorization check setting: ' + error.message);
        await client.sendMessage(message.from, 'Error updating authorization check setting.');
    }
}

register('!checkauthorized', handler);
