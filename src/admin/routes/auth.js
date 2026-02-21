const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getConnectionStatus } = require('./connection');

// Rate-limit login attempts: 5 per 15 minutes per IP (Phase 5)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});

function loginRedirect(req) {
    return req.baseUrl + (getConnectionStatus() === 'ready' ? '/groups' : '/connection');
}

router.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect(loginRedirect(req));
    }
    res.render('login', { error: null });
});

router.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password && password === process.env.ADMIN_PASSWORD) {
        req.session.authenticated = true;
        return res.redirect(loginRedirect(req));
    }
    res.render('login', { error: 'Invalid password' });
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect(req.baseUrl + '/login');
    });
});

module.exports = router;
