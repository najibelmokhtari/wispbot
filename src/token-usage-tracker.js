const { getDatabase, getBotSetting, setBotSetting } = require('./db');
const logger = require('./logger');

class TokenUsageTracker {
    constructor(config) {
        this.config = config;
        this.lastCommitTime = Date.now();
        this.commitInterval = 30000; // 30 seconds, adjust as needed
        this.pendingWrites = [];
    }

    async initialize() {
        try {
            const db = await getDatabase();
            // Create the table if it doesn't exist
            await db.exec(`
                CREATE TABLE IF NOT EXISTS llm_api_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    group_id TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    extended_history_used BOOLEAN NOT NULL,
                    ai_model TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Schema Migration: Add new columns for Gemini/Cost tracking if they don't exist
            const columnsToAdd = [
                { name: 'cached_tokens', type: 'INTEGER DEFAULT 0' },
                { name: 'cost_usd', type: 'REAL DEFAULT 0.0' },
                { name: 'provider', type: "TEXT DEFAULT 'unknown'" },
                { name: 'tts_cost_usd', type: 'REAL DEFAULT 0.0' }
            ];

            for (const col of columnsToAdd) {
                try {
                    await db.exec(`ALTER TABLE llm_api_calls ADD COLUMN ${col.name} ${col.type}`);
                    // console.log(`Added column ${col.name} to llm_api_calls`);
                } catch (error) {
                    // Ignore error if column likely exists (SQLite doesn't support IF NOT EXISTS for ADD COLUMN)
                }
            }

            logger.info('TokenTracker', 'TokenUsageTracker initialized successfully');
        } catch (error) {
            logger.error('TokenTracker', 'Failed to initialize TokenUsageTracker: ' + error.message);
            throw error;
        }
    }

    async recordUsage(userId, groupId, inputTokens, outputTokens, extendedHistoryUsed, aiModel, cachedTokens = 0, costUsd = 0, provider = 'unknown', ttsCostUsd = 0, retries = 3) {
        try {
            this.pendingWrites.push({
                userId,
                groupId,
                inputTokens,
                outputTokens,
                extendedHistoryUsed,
                aiModel,
                cachedTokens,
                costUsd,
                provider,
                ttsCostUsd
            });

            if (this.pendingWrites.length >= 10 || Date.now() - this.lastCommitTime >= this.commitInterval) {
                await this.forceCommit();
            }
        } catch (error) {
            if (error.code === 'SQLITE_BUSY' && retries > 0) {
                logger.debug('TokenTracker', `Database busy, retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before retrying
                return this.recordUsage(userId, groupId, inputTokens, outputTokens, extendedHistoryUsed, aiModel, cachedTokens, costUsd, provider, ttsCostUsd, retries - 1);
            }
            logger.error('TokenTracker', 'Error recording API call: ' + error.message);
            throw error;
        }
    }

    async getUsageSummary(userId, startDate, endDate) {
        try {
            const db = await getDatabase();
            const result = await db.all(`
                SELECT
                    COUNT(*) as call_count,
                    SUM(input_tokens) as total_input_tokens,
                    SUM(output_tokens) as total_output_tokens,
                    SUM(cached_tokens) as total_cached_tokens,
                    SUM(cost_usd) as total_cost_usd,
                    SUM(CASE WHEN extended_history_used THEN 1 ELSE 0 END) as extended_history_count
                FROM llm_api_calls
                WHERE user_id = ? AND timestamp BETWEEN ? AND ?
            `, [userId, startDate, endDate]);
            return result[0];
        } catch (error) {
            logger.error('TokenTracker', 'Error getting usage summary: ' + error.message);
            throw error;
        }
    }

    async getGroupUsage(groupId, startDate, endDate) {
        try {
            const db = await getDatabase();
            const result = await db.all(`
                SELECT
                    user_id,
                    COUNT(*) as call_count,
                    SUM(input_tokens) as total_input_tokens,
                    SUM(output_tokens) as total_output_tokens,
                    SUM(cached_tokens) as total_cached_tokens,
                    SUM(cost_usd) as total_cost_usd
                FROM llm_api_calls
                WHERE group_id = ? AND timestamp BETWEEN ? AND ?
                GROUP BY user_id
            `, [groupId, startDate, endDate]);
            return result;
        } catch (error) {
            logger.error('TokenTracker', 'Error getting group usage: ' + error.message);
            throw error;
        }
    }

    async forceCommit() {
        if (this.pendingWrites.length === 0) {
            return; // No changes to commit
        }

        try {
            const db = await getDatabase();
            await db.run('BEGIN TRANSACTION');

            for (const write of this.pendingWrites) {
                await db.run(`
                    INSERT INTO llm_api_calls
                    (user_id, group_id, input_tokens, output_tokens, extended_history_used, ai_model, cached_tokens, cost_usd, provider, tts_cost_usd)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    write.userId,
                    write.groupId,
                    write.inputTokens,
                    write.outputTokens,
                    write.extendedHistoryUsed,
                    write.aiModel,
                    write.cachedTokens || 0,
                    write.costUsd || 0,
                    write.provider || 'unknown',
                    write.ttsCostUsd || 0
                ]);
            }

            await db.run('COMMIT');
            // Clear pending writes immediately after confirmed commit
            // so they aren't lost if _checkUsageLimit throws
            this.pendingWrites = [];
            this.lastCommitTime = Date.now();
            logger.info('TokenTracker', 'Forced commit completed');

            // Check usage hard limit
            await this._checkUsageLimit(db);
        } catch (error) {
            logger.error('TokenTracker', 'Error forcing commit: ' + error.message);
            try {
                const db = await getDatabase();
                await db.run('ROLLBACK');
            } catch (rollbackError) {
                logger.error('TokenTracker', 'Rollback also failed: ' + rollbackError.message);
            }
            throw error;
        }
    }
    async _checkUsageLimit(db) {
        try {
            const limitStr = await getBotSetting('usage_hard_limit');
            if (!limitStr) return; // No limit configured

            const limit = parseFloat(limitStr);
            if (isNaN(limit) || limit <= 0) return;

            const mode = await getBotSetting('usage_cap_mode') || 'manual';
            const botActive = await getBotSetting('bot_active');

            let resetDate;
            if (mode === 'monthly') {
                // Use 1st of current UTC month
                const now = new Date();
                resetDate = now.getUTCFullYear() + '-' +
                    String(now.getUTCMonth() + 1).padStart(2, '0') +
                    '-01 00:00:00';

                // In monthly mode, auto re-enable bot if a new month has started
                if (botActive === '0') {
                    const disabledResetDate = await getBotSetting('usage_limit_reset_date') || '';
                    // If the stored reset date is from a previous month, re-enable
                    if (disabledResetDate && disabledResetDate < resetDate) {
                        await setBotSetting('bot_active', '1');
                        logger.info('TokenTracker', `New month started — bot auto re-enabled (monthly cap mode)`);
                        // Continue to check if we're already over limit this month
                    } else if (!disabledResetDate) {
                        // No stored date, new month logic: re-enable and check
                        await setBotSetting('bot_active', '1');
                    } else {
                        return; // Same month, still disabled
                    }
                }
            } else {
                // Manual mode
                if (botActive === '0') return; // Already disabled
                resetDate = await getBotSetting('usage_limit_reset_date') || '2000-01-01 00:00:00';
            }

            const totals = await db.get(`
                SELECT COALESCE(SUM(cost_usd), 0) as cost_usd
                FROM llm_api_calls
                WHERE timestamp >= ?
            `, [resetDate]);

            if (totals.cost_usd >= limit) {
                await setBotSetting('bot_active', '0');
                // Store when we disabled so monthly mode can detect new month
                if (mode === 'monthly') {
                    await setBotSetting('usage_limit_reset_date', resetDate);
                }
                logger.warn('TokenTracker', `Usage limit exceeded ($${totals.cost_usd.toFixed(4)} >= $${limit.toFixed(2)}) — bot has been disabled`);
            }
        } catch (error) {
            logger.error('TokenTracker', 'Error checking usage limit: ' + error.message);
        }
    }
}

module.exports = TokenUsageTracker;