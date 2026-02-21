const express = require('express');
const router = express.Router();
const { getDatabase } = require('../../db');

router.get('/api/health', async (req, res) => {
    const health = {
        status: 'unknown',
        uptime: Math.floor(process.uptime()),
        db: 'unknown',
        queue_depth: 0,
        timestamp: new Date().toISOString()
    };

    try {
        // Check WhatsApp connection status
        const client = req.sharedState?.whatsappClient;
        health.status = (client && client.info) ? 'connected' : 'disconnected';

        // Check database
        try {
            const db = await getDatabase();
            await db.get('SELECT 1');
            health.db = 'ok';
        } catch (dbError) {
            health.db = 'error';
        }

        // Get queue depth
        if (req.sharedState?.messageQueueManager) {
            health.queue_depth = req.sharedState.messageQueueManager.messageQueue?.length || 0;
        }

        const statusCode = (health.status === 'connected' && health.db === 'ok') ? 200 : 503;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(503).json({ ...health, status: 'error', error: error.message });
    }
});

module.exports = router;
