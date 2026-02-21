const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const conversationStore = require('../conversation-store');
const { authorizeGroupParticipants } = require('../services/auth');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const chat = await message.getChat();

        if (!chat.isGroup) {
            await client.sendMessage(message.from, 'This command can only be used in group chats.');
            return;
        }

        const commandMatch = message.body.match(/!setupgroup/i);
        const argsData = message.body.slice(commandMatch.index + commandMatch[0].length).trim();

        if (!argsData) {
            await client.sendMessage(message.from, 'Please provide a group name. Usage: !setupgroup <name>');
            return;
        }

        const newGroupName = argsData;
        const groupId = message.from;

        await getOrCreateGroupInfo(groupId, newGroupName);
        await updateGroupInfo(groupId, { group_name: newGroupName, is_active: 1 });

        const { newUserIds, totalParticipants } = await authorizeGroupParticipants(chat, config);

        const contextFileName = `${groupId}.txt`;
        const contextFilePath = path.join(__dirname, '..', '..', 'prompts', 'group_contexts', contextFileName);

        await fs.mkdir(path.dirname(contextFilePath), { recursive: true });

        let contextMsg = '';
        try {
            await fs.access(contextFilePath);
            contextMsg = 'Context file already exists.';
        } catch {
            const initialContent = `group context for ${newGroupName}. modify me`;
            await fs.writeFile(contextFilePath, initialContent, 'utf-8');
            contextMsg = 'Created new group context file.';
        }

        let response = `✅ **Group Setup Complete**\n\n`;
        response += `🏷️ **Name:** ${newGroupName}\n`;
        response += `👥 **Authorization:** ${newUserIds.length} new members authorized (Total: ${totalParticipants})\n`;
        response += `📄 **Context:** ${contextMsg}\n`;
        response += `\nYou can now edit the context file at: \`prompts/group_contexts/${contextFileName}\``;

        await client.sendMessage(message.from, response);

        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null
        });

        logger.info('Cmd', `Setup complete for group ${groupId}: Name="${newGroupName}", NewAuth=${newUserIds.length}`);

    } catch (error) {
        logger.error('Cmd', 'Error processing !setupgroup: ' + error.message);
        await client.sendMessage(message.from, `Error setting up group: ${error.message}`);
    }
}

register('!setupgroup', handler);
