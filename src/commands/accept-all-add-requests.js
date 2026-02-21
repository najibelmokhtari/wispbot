const { register } = require('./index');
const { getAddRequests, clearAddRequests, setUserAuthorized } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const requests = await getAddRequests();
        if (requests.length === 0) {
            await client.sendMessage(message.from, 'There are no pending add requests to accept.');
            return;
        }

        for (const r of requests) {
            await setUserAuthorized(r.user_id, true);
        }
        await clearAddRequests();
        await client.sendMessage(message.from, `Accepted all ${requests.length} requests. The authorized users list has been updated.`);
    } catch (error) {
        logger.error('Cmd', 'Error accepting all add requests: ' + error.message);
        await client.sendMessage(message.from, 'Error accepting all add requests.');
    }
}

register('!acceptalladdrequests', handler);
