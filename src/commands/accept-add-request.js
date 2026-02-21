const { register } = require('./index');
const { removeAddRequest, setUserAuthorized } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    const parts = message.body.split(' ');
    const userId = parts[1];
    if (!userId) {
        await client.sendMessage(message.from, 'Please provide the user ID to accept.');
        return;
    }

    try {
        await setUserAuthorized(userId, true);
        await removeAddRequest(userId);
        await client.sendMessage(message.from, `User ${userId} has been added to the authorized list.`);
    } catch (error) {
        logger.error('Cmd', 'Error accepting add request: ' + error.message);
        await client.sendMessage(message.from, 'Error accepting add request.');
    }
}

register('!acceptaddrequest', handler);
