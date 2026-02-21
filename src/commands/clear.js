const { register } = require('./index');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const groupId = message.from;

        await conversationStore.addMessageToConversation(groupId, {
            sender: config.botName,
            message: "Clearing history...",
            timestamp: new Date().toISOString()
        });

        const response = 'Message history cleared (context reset).';
        await client.sendMessage(message.from, response);

        logger.info('Cmd', `Successfully cleared message context for chat: ${groupId}`);
    } catch (error) {
        logger.error('Cmd', 'Error clearing message history: ' + error.message);
    }
}

register('!clear', handler);
