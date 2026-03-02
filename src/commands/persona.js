const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const chatId = message.from;

        if (!chatId.endsWith('@g.us')) {
            await client.sendMessage(chatId, 'This command can only be used in groups.');
            return;
        }

        const groupInfo = await getOrCreateGroupInfo(chatId);
        const promptManager = config.messageQueueManager.promptManager;
        const availablePersonas = ['default', ...Array.from(promptManager.prompts.keys()).filter(n => n !== 'default').sort()];

        // Parse persona name from message body
        const args = message.body.replace(/^!persona\s*/i, '').trim();

        if (!args) {
            const current = groupInfo.default_prompt_name || 'default';
            let response = `Current persona: *${current}*\n\nAvailable personas:\n`;
            response += availablePersonas.map(p => `  ${p === current ? '→ ' : ''}${p}`).join('\n');
            await client.sendMessage(chatId, response);
            return;
        }

        const personaName = args.toLowerCase();

        if (!availablePersonas.includes(personaName)) {
            await client.sendMessage(chatId, `Unknown persona "${personaName}".\n\nAvailable: ${availablePersonas.join(', ')}`);
            return;
        }

        const currentPersona = groupInfo.default_prompt_name || 'default';
        if (personaName === currentPersona) {
            await client.sendMessage(chatId, `Already using the *${personaName}* persona.`);
            return;
        }

        await updateGroupInfo(chatId, { default_prompt_name: personaName });
        await client.sendMessage(chatId, `Persona switched from *${currentPersona}* to *${personaName}*.`);
        logger.info('Cmd', `Persona switched to "${personaName}" in group ${chatId}`);
    } catch (error) {
        logger.error('Cmd', 'Error switching persona: ' + error.message);
    }
}

register('!persona', handler);
