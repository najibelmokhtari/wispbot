const { register } = require('./index');
const conversationStore = require('../conversation-store');
const { authorizeGroupParticipants } = require('../services/auth');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const chat = await message.getChat();

        let result;
        try {
            result = await authorizeGroupParticipants(chat);
        } catch (e) {
            await client.sendMessage(message.from, e.message);
            return;
        }

        const { newUserIds, totalParticipants } = result;

        if (newUserIds.length === 0) {
            await client.sendMessage(message.from, `All group members are already authorized. (Total: ${totalParticipants})`);
            return;
        }

        const response = `Successfully authorized ${newUserIds.length} new member(s) from this group. Total participants: ${totalParticipants}, Already authorized: ${totalParticipants - newUserIds.length}`;
        await client.sendMessage(message.from, response);

        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });

        logger.info('Cmd', `Authorized ${newUserIds.length} members from group ${message.from}`);
    } catch (error) {
        logger.error('Cmd', 'Error authorizing all group members: ' + error.message);
        await client.sendMessage(message.from, 'Error authorizing group members.');
    }
}

register('!authorizeall', handler);
