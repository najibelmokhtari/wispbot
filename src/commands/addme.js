const { register } = require('./index');
const { addAddRequest, setCustomAlias, getUserAlias } = require('../db');
const logger = require('../logger');

async function handler(client, message) {
    try {
        const chatId = message.from;
        const senderId = message.author || message.from;

        if (!chatId.endsWith('@g.us')) {
            await client.sendMessage(chatId, 'You can only use this command in a group with the bot.');
            return;
        }

        const args = message.body.replace(/^!addme\s*/i, '').trim();
        if (args.length > 0) {
            await setCustomAlias(senderId, args);
        }

        const storedAlias = await getUserAlias(senderId);
        await addAddRequest(senderId, storedAlias);
        await client.sendMessage(chatId, `Hi ${storedAlias}, your request to be added has been sent to the admins.`);
        logger.info('Cmd', `Add request from ${senderId} (${storedAlias})`);
    } catch (error) {
        logger.error('Cmd', 'Error processing addme: ' + error.message);
    }
}

register('!addme', handler, { adminOnly: false, public: true });
