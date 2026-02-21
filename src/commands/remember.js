const { register } = require('./index');
const conversationStore = require('../conversation-store');
const { updateGroupInfo } = require('../db');
const logger = require('../logger');

const MAX_REMEMBER_LIMIT = 500;

async function handler(client, message, config) {
    try {
        const parts = message.body.split(' ');
        const requestedLimit = parseInt(parts[1]);
        if (isNaN(requestedLimit) || requestedLimit < 1) {
            const response = 'Invalid limit. Please provide a positive integer (max 500).';
            await client.sendMessage(message.from, response);
            return;
        }

        const newLimit = Math.min(requestedLimit, MAX_REMEMBER_LIMIT);

        // Persist to database
        await updateGroupInfo(message.from, { custom_message_limit: newLimit });

        let response = `Message history limit for this chat set to: ${newLimit}`;
        if (requestedLimit > MAX_REMEMBER_LIMIT) {
            response += ` (capped from ${requestedLimit})`;
        }

        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });
        logger.info('Cmd', `Successfully set message history limit for chat ${message.from} to ${newLimit}`);
    } catch (error) {
        logger.error('Cmd', 'Error setting message history limit: ' + error.message);
    }
}

register('!remember', handler);
