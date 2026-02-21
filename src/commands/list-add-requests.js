const { register } = require('./index');
const { getAddRequests } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    try {
        const requests = await getAddRequests();
        if (requests.length === 0) {
            await client.sendMessage(message.from, 'There are no pending add requests.');
            return;
        }

        let response = 'Pending add requests:\n\n';
        for (const request of requests) {
            response += `Name: ${request.user_name}\nID: ${request.user_id}\n\n`;
        }
        await client.sendMessage(message.from, response);
    } catch (error) {
        logger.error('Cmd', 'Error listing add requests: ' + error.message);
        await client.sendMessage(message.from, 'Error listing add requests.');
    }
}

register('!listaddrequests', handler);
