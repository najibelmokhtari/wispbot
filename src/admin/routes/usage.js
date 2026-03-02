const express = require('express');
const router = express.Router();
const logger = require('../../logger');
const { getDatabase, getUserNameById, getAllGroupInfo, getBotSetting, setBotSetting } = require('../../db');

// Page: Usage dashboard
router.get('/usage', (req, res) => {
    res.render('usage', { basePath: req.app.locals.basePath });
});

// API: global usage stats (across all groups)
router.get('/api/usage/global', async (req, res) => {
    try {
        const period = req.query.period || '30d';

        function toSqliteDate(d) {
            return d.getUTCFullYear() + '-' +
                String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                String(d.getUTCDate()).padStart(2, '0') + ' ' +
                String(d.getUTCHours()).padStart(2, '0') + ':' +
                String(d.getUTCMinutes()).padStart(2, '0') + ':' +
                String(d.getUTCSeconds()).padStart(2, '0');
        }

        let startDateStr;
        const now = new Date();
        if (period === '7d') {
            startDateStr = toSqliteDate(new Date(now - 7 * 24 * 60 * 60 * 1000));
        } else if (period === '30d') {
            startDateStr = toSqliteDate(new Date(now - 30 * 24 * 60 * 60 * 1000));
        } else {
            startDateStr = '2000-01-01 00:00:00';
        }

        const db = await getDatabase();

        // Grand totals
        const totals = await db.get(`
            SELECT
                COUNT(*) as call_count,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                COALESCE(SUM(cost_usd), 0) as cost_usd,
                COALESCE(SUM(COALESCE(tts_cost_usd, 0)), 0) as tts_cost_usd
            FROM llm_api_calls
            WHERE timestamp >= ?
        `, [startDateStr]);

        // By model
        const byModel = await db.all(`
            SELECT
                ai_model,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd,
                SUM(COALESCE(tts_cost_usd, 0)) as tts_cost_usd
            FROM llm_api_calls
            WHERE timestamp >= ?
            GROUP BY ai_model
            ORDER BY cost_usd DESC
        `, [startDateStr]);

        // By group
        const byGroup = await db.all(`
            SELECT
                group_id,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd,
                SUM(COALESCE(tts_cost_usd, 0)) as tts_cost_usd
            FROM llm_api_calls
            WHERE timestamp >= ?
            GROUP BY group_id
            ORDER BY cost_usd DESC
        `, [startDateStr]);

        // Resolve group names
        const allGroups = await getAllGroupInfo();
        const groupMap = {};
        for (const g of allGroups) {
            groupMap[g.group_id] = g.group_name || g.group_id;
        }
        for (const row of byGroup) {
            row.group_name = groupMap[row.group_id] || row.group_id;
        }

        // By user
        const byUser = await db.all(`
            SELECT
                user_id,
                COUNT(*) as call_count,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cached_tokens) as cached_tokens,
                SUM(cost_usd) as cost_usd,
                SUM(COALESCE(tts_cost_usd, 0)) as tts_cost_usd
            FROM llm_api_calls
            WHERE timestamp >= ?
            GROUP BY user_id
            ORDER BY cost_usd DESC
        `, [startDateStr]);

        // Resolve user names
        for (const row of byUser) {
            if (row.user_id === 'background-processor') {
                row.user_name = 'Background Processing';
            } else {
                const name = await getUserNameById(row.user_id);
                row.user_name = name || row.user_id.replace(/@c\.us$/, '');
            }
        }

        res.json({ totals, byModel, byGroup, byUser });
    } catch (error) {
        logger.error('Admin', 'Error fetching global usage: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch usage data' });
    }
});

// Helper: get 1st of current UTC month as SQLite date string
function getMonthlyResetDate() {
    const now = new Date();
    return now.getUTCFullYear() + '-' +
        String(now.getUTCMonth() + 1).padStart(2, '0') +
        '-01 00:00:00';
}

// API: get usage limit status (spend since last reset vs limit)
router.get('/api/usage/limit-status', async (req, res) => {
    try {
        const db = await getDatabase();
        const limit = await getBotSetting('usage_hard_limit') || '';
        const mode = await getBotSetting('usage_cap_mode') || 'manual';
        const manualResetDate = await getBotSetting('usage_limit_reset_date') || '';
        const botActive = await getBotSetting('bot_active');

        let startDateStr;
        let resetDate;
        if (mode === 'monthly') {
            startDateStr = getMonthlyResetDate();
            resetDate = startDateStr;
        } else {
            startDateStr = manualResetDate || '2000-01-01 00:00:00';
            resetDate = manualResetDate || null;
        }

        const totals = await db.get(`
            SELECT
                COALESCE(SUM(cost_usd), 0) as cost_usd
            FROM llm_api_calls
            WHERE timestamp >= ?
        `, [startDateStr]);

        res.json({
            limit: limit ? parseFloat(limit) : null,
            mode,
            spent: totals.cost_usd || 0,
            resetDate,
            botActive: botActive !== '0'
        });
    } catch (error) {
        logger.error('Admin', 'Error fetching usage limit status: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch usage limit status' });
    }
});

// API: save usage hard limit and mode
router.post('/api/usage/limit', async (req, res) => {
    try {
        const { limit, mode } = req.body;
        const val = parseFloat(limit);
        if (limit === '' || limit === null || limit === undefined) {
            await setBotSetting('usage_hard_limit', '');
        } else if (isNaN(val) || val < 0) {
            return res.status(400).json({ error: 'Invalid limit value' });
        } else {
            await setBotSetting('usage_hard_limit', String(val));
        }

        // Save mode if provided
        if (mode === 'monthly' || mode === 'manual') {
            const prevMode = await getBotSetting('usage_cap_mode') || 'manual';
            await setBotSetting('usage_cap_mode', mode);

            // When switching to monthly, re-enable bot if it was disabled and we're in a new month
            if (mode === 'monthly' && prevMode !== 'monthly') {
                const botActive = await getBotSetting('bot_active');
                if (botActive === '0') {
                    // Re-enable — monthly mode starts fresh from the 1st
                    await setBotSetting('bot_active', '1');
                    logger.info('Admin', 'Switched to monthly cap mode — bot re-enabled');
                }
            }
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving usage limit: ' + error.message);
        res.status(500).json({ error: 'Failed to save usage limit' });
    }
});

// API: reset usage billing cycle (and re-enable bot) — manual mode only
router.post('/api/usage/reset', async (req, res) => {
    try {
        const mode = await getBotSetting('usage_cap_mode') || 'manual';
        if (mode === 'monthly') {
            return res.status(400).json({ error: 'Cannot manually reset in monthly mode. Spending resets automatically on the 1st of each month.' });
        }

        const now = new Date();
        const resetDate = now.getUTCFullYear() + '-' +
            String(now.getUTCMonth() + 1).padStart(2, '0') + '-' +
            String(now.getUTCDate()).padStart(2, '0') + ' ' +
            String(now.getUTCHours()).padStart(2, '0') + ':' +
            String(now.getUTCMinutes()).padStart(2, '0') + ':' +
            String(now.getUTCSeconds()).padStart(2, '0');
        await setBotSetting('usage_limit_reset_date', resetDate);
        await setBotSetting('bot_active', '1');
        logger.info('Admin', `Usage billing cycle reset at ${resetDate}, bot re-enabled`);
        res.json({ success: true, resetDate });
    } catch (error) {
        logger.error('Admin', 'Error resetting usage cycle: ' + error.message);
        res.status(500).json({ error: 'Failed to reset usage cycle' });
    }
});

module.exports = router;
