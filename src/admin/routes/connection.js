const express = require('express');
const router = express.Router();
const logger = require('../../logger');

// Track connection state so polling clients always get the current status
let lastQr = null;
let connectionStatus = 'waiting';
let statusMessage = 'Waiting for WhatsApp connection...';
let statusInfo = null;

// Called from admin-server.js at startup to track state before any browser connects
function initConnectionCache(client) {
    client.on('qr', (qr) => {
        lastQr = qr;
        connectionStatus = 'qr';
        statusMessage = 'QR code ready. Scan with WhatsApp.';
        statusInfo = null;
    });
    client.on('authenticated', () => {
        lastQr = null;
        connectionStatus = 'authenticated';
        statusMessage = 'Authenticated successfully. Loading...';
        statusInfo = null;
    });
    client.on('loading_screen', (percent, message) => {
        connectionStatus = 'loading';
        statusMessage = 'Loading: ' + percent + '% - ' + message;
        statusInfo = { percent };
    });
    client.on('ready', () => {
        lastQr = null;
        connectionStatus = 'ready';
        statusMessage = 'WhatsApp is connected';
        statusInfo = {
            pushname: client.info ? client.info.pushname : null,
            phone: client.info && client.info.wid ? client.info.wid.user : null
        };
    });
    client.on('auth_failure', (msg) => {
        lastQr = null;
        connectionStatus = 'auth_failure';
        statusMessage = 'Authentication failed: ' + msg;
        statusInfo = null;
    });
    client.on('disconnected', (reason) => {
        lastQr = null;
        connectionStatus = 'disconnected';
        statusMessage = 'Disconnected: ' + reason;
        statusInfo = null;
    });
    client.on('change_state', (state) => {
        // If authenticated but not ready, show the internal state for diagnostics
        if (connectionStatus === 'authenticated' || connectionStatus === 'loading') {
            statusMessage = 'Authenticated. Syncing... (state: ' + state + ')';
        }
    });
}

// Page route
router.get('/connection', (req, res) => {
    res.render('connection');
});

// Polling endpoint: returns current connection state as JSON
router.get('/api/connection/status', (req, res) => {
    const client = req.sharedState.whatsappClient;

    // If status is still 'authenticated' or 'loading' after a while but client.info
    // is available, don't auto-promote to 'ready' — wait for the actual 'ready' event.

    const response = {
        status: connectionStatus,
        message: statusMessage
    };

    if (lastQr) response.qr = lastQr;
    if (statusInfo) response.info = statusInfo;

    res.json(response);
});

// Disconnect the WhatsApp client
router.post('/api/connection/disconnect', async (req, res) => {
    const client = req.sharedState.whatsappClient;
    logger.info('Connection', `Disconnect requested (current status: ${connectionStatus})`);
    if (connectionStatus !== 'ready') {
        logger.warn('Connection', `Disconnect rejected: status is "${connectionStatus}", not "ready"`);
        return res.status(400).json({ error: 'Bot is not connected' });
    }
    try {
        logger.info('Connection', 'Calling client.logout()...');
        await client.logout();
        logger.info('Connection', 'client.logout() completed successfully');
    } catch (e) {
        logger.warn('Connection', `client.logout() failed: ${e.message}, falling back to client.destroy()`);
        try {
            await client.destroy();
            logger.info('Connection', 'client.destroy() completed successfully');
        } catch (e2) {
            logger.error('Connection', `client.destroy() also failed: ${e2.message}`);
            return res.status(500).json({ error: 'Failed to disconnect: ' + e.message });
        }
    }
    lastQr = null;
    connectionStatus = 'disconnected';
    statusMessage = 'Disconnected by admin';
    statusInfo = null;
    res.json({ ok: true });
});

// Reconnect the WhatsApp client
router.post('/api/connection/connect', async (req, res) => {
    const client = req.sharedState.whatsappClient;
    logger.info('Connection', `Connect requested (current status: ${connectionStatus})`);
    if (connectionStatus === 'ready') {
        return res.status(400).json({ error: 'Bot is already connected' });
    }
    if (connectionStatus === 'qr' || connectionStatus === 'authenticated' || connectionStatus === 'loading') {
        return res.status(400).json({ error: 'Connection already in progress' });
    }
    try {
        connectionStatus = 'waiting';
        statusMessage = 'Reconnecting...';
        statusInfo = null;
        lastQr = null;
        logger.info('Connection', 'Calling client.initialize()...');
        client.initialize().catch((err) => {
            logger.error('Connection', `client.initialize() failed: ${err.message}`);
            connectionStatus = 'disconnected';
            statusMessage = 'Reconnection failed: ' + err.message;
        });
        res.json({ ok: true });
    } catch (e) {
        logger.error('Connection', `Connect failed: ${e.message}`);
        res.status(500).json({ error: 'Failed to connect: ' + e.message });
    }
});

function getConnectionStatus() {
    return connectionStatus;
}

module.exports = { router, initConnectionCache, getConnectionStatus };
