const { register } = require('./index');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const response = 'pong';
        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });
    } catch (error) {
        logger.error('Cmd', 'Error sending pong response: ' + error.message);
    }
}

register('!ping', handler);
