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

        if (!groupInfo.is_active) {
            await client.sendMessage(chatId, 'Bot is already stopped in this group.');
            return;
        }

        await updateGroupInfo(chatId, { is_active: 0 });
        await client.sendMessage(chatId, 'Bot stopped. Use *!start* to reactivate.');
        logger.info('Cmd', `Bot stopped in group ${chatId}`);
    } catch (error) {
        logger.error('Cmd', 'Error stopping bot: ' + error.message);
    }
}

register('!stop', handler);
