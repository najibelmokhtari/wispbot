const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const logger = require('../logger');

// !listen toggles active listening; !listen on / !listen off sets it explicitly
async function handler(client, message) {
    try {
        const chatId = message.from;

        if (!chatId.endsWith('@g.us')) {
            await client.sendMessage(chatId, 'This command can only be used in groups.');
            return;
        }

        const arg = message.body.replace(/^.*?!listen\b/i, '').trim().toLowerCase();
        if (arg && arg !== 'on' && arg !== 'off') {
            await client.sendMessage(chatId, 'Usage: *!listen* to toggle active listening, or *!listen on* / *!listen off*.');
            return;
        }

        const groupInfo = await getOrCreateGroupInfo(chatId);
        const isOn = groupInfo.active_listening_enabled === 1;
        const turnOn = arg ? arg === 'on' : !isOn;

        if (turnOn === isOn) {
            await client.sendMessage(chatId, `Active listening is already ${isOn ? 'on' : 'off'} in this group.`);
            return;
        }

        await updateGroupInfo(chatId, { active_listening_enabled: turnOn ? 1 : 0 });
        await client.sendMessage(chatId, turnOn
            ? "Active listening is on. I'll join the conversation when I have something useful to add, no need to tag me."
            : "Active listening is off. I'll only reply when someone tags me or replies to me.");
        logger.info('Cmd', `Active listening turned ${turnOn ? 'on' : 'off'} in group ${chatId}`);
    } catch (error) {
        logger.error('Cmd', 'Error toggling active listening: ' + error.message);
    }
}

register('!listen', handler);
