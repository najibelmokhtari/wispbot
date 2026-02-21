const express = require('express');
const router = express.Router();
const logger = require('../../logger');
const {
    getDatabase,
    getAddRequests,
    removeAddRequest,
    clearAddRequests,
    setUserAuthorized,
    setUserAdmin,
    getAuthorizedUsersWithNames,
    getAdminUsersWithNames,
    validateUserId,
    upsertUser
} = require('../../db');

// Resolve missing names from WhatsApp client and cache in DB
async function resolveNames(users, client) {
    if (!client) return users;
    for (const u of users) {
        if (u.name) continue;
        try {
            const contact = await client.getContactById(u.id);
            const resolved = contact.pushname || contact.name || null;
            if (resolved) {
                u.name = resolved;
                await upsertUser(u.id, resolved);
            }
        } catch (e) {
            // Contact lookup failed, leave as null
        }
    }
    return users;
}

// Users management page
router.get('/users', async (req, res) => {
    try {
        const client = req.sharedState?.whatsappClient;
        const authorized = await getAuthorizedUsersWithNames();
        const admins = await getAdminUsersWithNames();
        const addRequests = await getAddRequests();
        await resolveNames(authorized, client);
        await resolveNames(admins, client);
        res.render('users', { authorized, admins, addRequests });
    } catch (error) {
        logger.error('Admin', 'Error loading users: ' + error.message);
        res.status(500).send('Error loading users');
    }
});

// API: list authorized users
router.get('/api/authorized-users', async (req, res) => {
    try {
        const users = await getAuthorizedUsersWithNames();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load authorized users' });
    }
});

// API: add authorized user
router.post('/api/authorized-users', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId || !userId.trim()) return res.status(400).json({ error: 'User ID required' });
        try { validateUserId(userId.trim()); } catch (e) { return res.status(400).json({ error: e.message }); }
        await setUserAuthorized(userId.trim(), true);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add user' });
    }
});

// API: remove authorized user
router.delete('/api/authorized-users/:userId', async (req, res) => {
    try {
        const userId = decodeURIComponent(req.params.userId);
        await setUserAuthorized(userId, false);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove user' });
    }
});

// API: list admin users
router.get('/api/admin-users', async (req, res) => {
    try {
        const users = await getAdminUsersWithNames();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load admin users' });
    }
});

// API: add admin user
router.post('/api/admin-users', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId || !userId.trim()) return res.status(400).json({ error: 'User ID required' });
        try { validateUserId(userId.trim()); } catch (e) { return res.status(400).json({ error: e.message }); }
        await setUserAdmin(userId.trim(), true);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add admin' });
    }
});

// API: remove admin user
router.delete('/api/admin-users/:userId', async (req, res) => {
    try {
        const userId = decodeURIComponent(req.params.userId);
        await setUserAdmin(userId, false);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove admin' });
    }
});

// API: get add requests
router.get('/api/add-requests', async (req, res) => {
    try {
        const requests = await getAddRequests();
        res.json(requests);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load add requests' });
    }
});

// API: accept add request
router.post('/api/add-requests/:userId/accept', async (req, res) => {
    try {
        const userId = decodeURIComponent(req.params.userId);
        await setUserAuthorized(userId, true);
        await removeAddRequest(userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to accept request' });
    }
});

// API: reject add request
router.delete('/api/add-requests/:userId', async (req, res) => {
    try {
        const userId = decodeURIComponent(req.params.userId);
        await removeAddRequest(userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// API: accept all add requests
router.post('/api/add-requests/accept-all', async (req, res) => {
    try {
        const requests = await getAddRequests();
        for (const r of requests) {
            await setUserAuthorized(r.user_id, true);
        }
        await clearAddRequests();
        res.json({ success: true, count: requests.length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to accept all requests' });
    }
});

// API: search known users (for autocomplete)
router.get('/api/known-users', async (req, res) => {
    try {
        const db = await getDatabase();
        const q = req.query.q || '';
        let users;
        if (q) {
            users = await db.all(
                `SELECT user_id, whatsapp_name, custom_alias FROM users
                 WHERE user_id LIKE ? OR whatsapp_name LIKE ? OR custom_alias LIKE ?
                 ORDER BY last_seen_timestamp DESC LIMIT 50`,
                [`%${q}%`, `%${q}%`, `%${q}%`]
            );
        } else {
            users = await db.all(
                'SELECT user_id, whatsapp_name, custom_alias FROM users ORDER BY last_seen_timestamp DESC LIMIT 50'
            );
        }
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search users' });
    }
});

module.exports = router;
