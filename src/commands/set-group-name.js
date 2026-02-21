const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const conversationStore = require('../conversation-store');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const commandMatch = message.body.match(/!setgroupname/i);
        if (!commandMatch) {
            await client.sendMessage(message.from, 'Invalid command format.');
            return;
        }

        const newGroupName = message.body.slice(commandMatch.index + commandMatch[0].length).trim();

        if (!newGroupName || newGroupName.length === 0) {
            await client.sendMessage(message.from, 'Please provide a group name. Usage: !setgroupname <name>');
            return;
        }

        const groupId = message.from;

        await getOrCreateGroupInfo(groupId, newGroupName);
        await updateGroupInfo(groupId, { group_name: newGroupName });

        const response = `Group name updated to: ${newGroupName}`;
        await client.sendMessage(message.from, response);

        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });

        logger.info('Cmd', `Group name updated for ${groupId} to: ${newGroupName}`);
    } catch (error) {
        logger.error('Cmd', 'Error setting group name: ' + error.message);
        await client.sendMessage(message.from, 'Error setting group name.');
    }
}

register('!setgroupname', handler);
