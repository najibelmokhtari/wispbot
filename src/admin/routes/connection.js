const express = require('express');
const router = express.Router();
const logger = require('../../logger');
const fs = require('fs').promises;
const config = require('../../config');

// Connection state is now managed by bot.js and exposed via getConnectionState()
// This module just provides the admin routes that read/write that state.

// Page route
router.get('/connection', (req, res) => {
    res.render('connection');
});

// Polling endpoint: returns current connection state as JSON
router.get('/api/connection/status', (req, res) => {
    const botModule = require('../../bot');
    const state = botModule.getConnectionState();

    const response = {
        status: state.status,
        message: getStatusMessage(state.status)
    };

    if (state.lastQr) response.qr = state.lastQr;
    if (state.lastQrDataUrl) response.qrDataUrl = state.lastQrDataUrl;
    if (state.info) response.info = state.info;
    if (state.alert) response.alert = state.alert;

    res.json(response);
});

function getStatusMessage(status) {
    const messages = {
        'waiting': 'Waiting for WhatsApp connection...',
        'qr': 'QR code ready. Scan with WhatsApp.',
        'loading': 'Connecting to WhatsApp...',
        'ready': 'WhatsApp is connected',
        'reconnecting': 'Disconnected. Reconnecting...',
        'disconnected': 'Disconnected',
    };
    return messages[status] || 'Unknown status';
}

// Disconnect the WhatsApp client
router.post('/api/connection/disconnect', async (req, res) => {
    const botModule = require('../../bot');
    const state = botModule.getConnectionState();
    logger.info('Connection', `Disconnect requested (current status: ${state.status})`);

    if (state.status !== 'ready') {
        logger.warn('Connection', `Disconnect rejected: status is "${state.status}", not "ready"`);
        return res.status(400).json({ error: 'Bot is not connected' });
    }

    try {
        const sock = botModule.getSock();
        if (sock) {
            logger.info('Connection', 'Calling sock.logout()...');
            await sock.logout();
            logger.info('Connection', 'sock.logout() completed successfully');
        }
        // Delete auth session to force new QR scan
        try {
            await fs.rm(config.authSessionPath, { recursive: true, force: true });
        } catch (e) {
            logger.warn('Connection', `Failed to delete auth session: ${e.message}`);
        }
        res.json({ ok: true });
    } catch (e) {
        logger.error('Connection', `Disconnect failed: ${e.message}`);
        try {
            const sock = botModule.getSock();
            if (sock) sock.end(undefined);
        } catch (e2) {
            logger.error('Connection', `sock.end() also failed: ${e2.message}`);
        }
        res.json({ ok: true, warning: 'Forced disconnect' });
    }
});

// Reconnect the WhatsApp client
router.post('/api/connection/connect', async (req, res) => {
    const botModule = require('../../bot');
    const state = botModule.getConnectionState();
    logger.info('Connection', `Connect requested (current status: ${state.status})`);

    if (state.status === 'ready') {
        return res.status(400).json({ error: 'Bot is already connected' });
    }
    if (state.status === 'qr' || state.status === 'loading') {
        return res.status(400).json({ error: 'Connection already in progress' });
    }

    try {
        logger.info('Connection', 'Starting new socket connection...');
        botModule.startSocket();
        res.json({ ok: true });
    } catch (e) {
        logger.error('Connection', `Connect failed: ${e.message}`);
        res.status(500).json({ error: 'Failed to connect: ' + e.message });
    }
});

function getConnectionStatus() {
    const botModule = require('../../bot');
    return botModule.getConnectionState().status;
}

// These are no longer needed since bot.js manages connection state directly,
// but we keep them as no-ops for backward compatibility with admin-server.js
function initConnectionCache() {}
function reattachConnectionListeners() {}

module.exports = { router, initConnectionCache, reattachConnectionListeners, getConnectionStatus };
