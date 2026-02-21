const { register } = require('./index');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const chat = await message.getChat();
        const groupId = message.from;

        let response;
        if (chat.isGroup) {
            response = `Group ID: ${groupId}`;
        } else {
            response = `Chat ID: ${groupId}\n(Note: This is a direct message, not a group)`;
        }

        await client.sendMessage(message.from, response);

        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });

        logger.info('Cmd', `Group ID request from admin in chat: ${groupId}`);
    } catch (error) {
        logger.error('Cmd', 'Error getting group ID: ' + error.message);
        await client.sendMessage(message.from, 'Error getting group ID.');
    }
}

register('!groupid', handler);
