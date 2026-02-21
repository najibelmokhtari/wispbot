const { register } = require('./index');
const conversationStore = require('../conversation-store');
const { getOrCreateGroupInfo } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const parts = message.body.split(' ');
        const promptName = parts[1] || 'default';

        if (!config.messageQueueManager) {
            throw new Error('MessageQueueManager is not initialized');
        }

        await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');

        const success = await config.messageQueueManager.setGroupPrompt(message.from, promptName);
        const response = success
            ? `Switched to prompt: ${promptName}`
            : `Failed to switch prompt. Check if ${promptName} exists.`;
        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });
        logger.info('Cmd', `Successfully switched prompt to: ${promptName} for chat ${message.from}`);
    } catch (error) {
        logger.error('Cmd', 'Error switching prompt: ' + error.message);
        await client.sendMessage(message.from, `Error switching prompt: ${error.message}`);
    }
}

register('!switch', handler);
