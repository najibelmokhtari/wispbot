const { register } = require('./index');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const parts = message.body.split(' ');
        const count = parseInt(parts[1]);

        if (isNaN(count) || count < 1) {
            await client.sendMessage(message.from, 'Please provide a valid positive number of messages to list.');
            return;
        }

        const groupId = message.from;
        const messages = await conversationStore.loadConversation(groupId, count);

        let response = `Last ${messages.length} messages in this chat:\n\n`;

        for (const msg of messages) {
            const timestamp = new Date(msg.timestamp).toLocaleString();
            response += `[${timestamp}] ${msg.sender}: ${msg.message}\n`;
            if (msg.quoted_msg) {
                try {
                    const quotedMsg = JSON.parse(msg.quoted_msg);
                    if (quotedMsg && quotedMsg.body) {
                        response += `  Quoted: ${quotedMsg.body}\n`;
                    } else {
                        response += `  Quoted: [No text content]\n`;
                    }
                } catch (error) {
                    response += `  Quoted: [Error parsing quoted message]\n`;
                }
            }
            if (msg.image_id) {
                response += `  [Image: ${msg.image_id}]\n`;
            }
            response += '\n';
        }

        await client.sendMessage(message.from, response);
        logger.info('Cmd', `Successfully listed ${messages.length} messages for chat ${groupId}`);
    } catch (error) {
        logger.error('Cmd', 'Error listing messages: ' + error.message);
        await client.sendMessage(message.from, `Error listing messages: ${error.message}`);
    }
}

register('!listmessages', handler);
