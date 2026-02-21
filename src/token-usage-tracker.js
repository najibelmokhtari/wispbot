const { getDatabase } = require('./db');
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
                CREATE TABLE IF NOT EXISTS claude_api_calls (
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
                { name: 'provider', type: "TEXT DEFAULT 'unknown'" }
            ];

            for (const col of columnsToAdd) {
                try {
                    await db.exec(`ALTER TABLE claude_api_calls ADD COLUMN ${col.name} ${col.type}`);
                    // console.log(`Added column ${col.name} to claude_api_calls`);
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

    async recordUsage(userId, groupId, inputTokens, outputTokens, extendedHistoryUsed, aiModel, cachedTokens = 0, costUsd = 0, provider = 'unknown', retries = 3) {
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
                provider
            });

            if (this.pendingWrites.length >= 10 || Date.now() - this.lastCommitTime >= this.commitInterval) {
                await this.forceCommit();
            }
        } catch (error) {
            if (error.code === 'SQLITE_BUSY' && retries > 0) {
                logger.debug('TokenTracker', `Database busy, retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before retrying
                return this.recordUsage(userId, groupId, inputTokens, outputTokens, extendedHistoryUsed, aiModel, cachedTokens, costUsd, provider, retries - 1);
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
                FROM claude_api_calls
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
                FROM claude_api_calls
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
                    INSERT INTO claude_api_calls
                    (user_id, group_id, input_tokens, output_tokens, extended_history_used, ai_model, cached_tokens, cost_usd, provider)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    write.userId,
                    write.groupId,
                    write.inputTokens,
                    write.outputTokens,
                    write.extendedHistoryUsed,
                    write.aiModel,
                    write.cachedTokens || 0,
                    write.costUsd || 0,
                    write.provider || 'unknown'
                ]);
            }

            await db.run('COMMIT');
            this.lastCommitTime = Date.now();
            this.pendingWrites = [];
            logger.info('TokenTracker', 'Forced commit completed');
        } catch (error) {
            logger.error('TokenTracker', 'Error forcing commit: ' + error.message);
            const db = await getDatabase();
            await db.run('ROLLBACK');
            throw error;
        }
    }
}

module.exports = TokenUsageTracker;