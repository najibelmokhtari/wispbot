const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const logger = require('../logger');

async function handler(client, message) {
    try {
        const chatId = message.from;

        if (!chatId.endsWith('@g.us')) {
            await client.sendMessage(chatId, 'This command can only be used in groups.');
            return;
        }

        const groupInfo = await getOrCreateGroupInfo(chatId);

        if (groupInfo.is_active) {
            await client.sendMessage(chatId, 'Bot is already active in this group.');
            return;
        }

        await updateGroupInfo(chatId, { is_active: 1 });
        await client.sendMessage(chatId, 'Bot reactivated.');
        logger.info('Cmd', `Bot started in group ${chatId}`);
    } catch (error) {
        logger.error('Cmd', 'Error starting bot: ' + error.message);
    }
}

register('!start', handler);
