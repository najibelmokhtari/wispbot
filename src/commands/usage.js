const { register } = require('./index');
const { getDatabase, isUserAdmin } = require('../db');
const logger = require('../logger');

async function handler(client, message, config) {
    const senderId = message.author || message.from;
    const isAdmin = await isUserAdmin(senderId);

    const args = message.body.trim().split(/\s+/);
    const param = args[1] ? args[1].toLowerCase() : null;

    let targetGroupId = message.from;

    try {
        const db = await getDatabase();

        // --- SCENARIO 1: Admin Quick View (No args) ---
        if (isAdmin && !param) {
            const userStats = await db.get(`
                SELECT
                    SUM(input_tokens) as input,
                    SUM(output_tokens) as output,
                    COUNT(*) as calls,
                    SUM(cached_tokens) as cached,
                    SUM(cost_usd) as cost,
                    SUM(CASE WHEN extended_history_used THEN 1 ELSE 0 END) as ext_history
                FROM claude_api_calls
                WHERE group_id = ? AND user_id = ?
            `, [targetGroupId, senderId]);

            const groupStats = await db.get(`
                SELECT
                    SUM(input_tokens) as input,
                    SUM(output_tokens) as output,
                    COUNT(*) as calls,
                    SUM(cached_tokens) as cached,
                    SUM(cost_usd) as cost,
                    SUM(CASE WHEN extended_history_used THEN 1 ELSE 0 END) as ext_history
                FROM claude_api_calls
                WHERE group_id = ?
            `, [targetGroupId]);

            if (!groupStats || groupStats.calls === 0) {
                await client.sendMessage(message.from, "No usage data found for this group.");
                return;
            }

            const formatCost = (val) => (val || 0).toFixed(4);
            const val = (v) => v || 0;

            let response = `📊 *Usage Report*\n\n`;

            response += `👤 *Your Usage:*\n`;
            response += `• Cost: $${formatCost(userStats?.cost)}\n`;
            response += `• Tokens: ${val(userStats?.input) + val(userStats?.output)} (In: ${val(userStats?.input)}, Out: ${val(userStats?.output)})\n`;
            response += `• Calls: ${val(userStats?.calls)}\n\n`;

            response += `WB *Group Total (All Users):*\n`;
            response += `• Cost: $${formatCost(groupStats.cost)}\n`;
            response += `• Tokens: ${val(groupStats.input) + val(groupStats.output)}\n`;
            response += `• Total Calls: ${val(groupStats.calls)}\n`;

            if (groupStats.cached > 0) {
                response += `• Cached Tokens: ${val(groupStats.cached)}\n`;
            }

            await client.sendMessage(message.from, response);
            return;
        }

        // --- SCENARIO 2: Detailed Lists (!usage all, !usage @user) ---
        let targetUserId = senderId;
        let showAllUsers = false;
        let modeDescription = "your usage in this chat";

        if (isAdmin) {
            if (param === 'all') {
                showAllUsers = true;
                targetUserId = null;
                modeDescription = "all users in this chat";
            } else if (param && (param.endsWith('@g.us') || param.endsWith('@c.us'))) {
                targetGroupId = args[1];
                showAllUsers = true;
                targetUserId = null;
                modeDescription = `all users in group ${targetGroupId}`;
            }
        }

        let query = `
            SELECT
                user_id,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                COUNT(*) as call_count,
                SUM(CASE WHEN extended_history_used THEN 1 ELSE 0 END) as extended_history_count,
                SUM(cached_tokens) as total_cached_tokens,
                SUM(cost_usd) as total_cost
            FROM claude_api_calls
            WHERE group_id = ?
        `;
        const queryParams = [targetGroupId];

        if (!showAllUsers && targetUserId) {
            query += ' AND user_id = ?';
            queryParams.push(targetUserId);
        }

        query += ' GROUP BY user_id ORDER BY total_input_tokens + total_output_tokens DESC';

        const results = await db.all(query, queryParams);

        if (results.length === 0) {
            await client.sendMessage(message.from, `No usage data found for ${modeDescription}.`);
            return;
        }

        let response = `Usage Summary (${modeDescription}):\n\n`;

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCalls = 0;
        let totalExtendedHistory = 0;
        let totalCachedTokens = 0;
        let totalCost = 0;

        for (const result of results) {
            const cost = result.total_cost ? result.total_cost.toFixed(4) : '0.0000';

            response += `User: ${result.user_id}\n`;
            response += `  Total Cost: $${cost}\n`;
            response += `  Total tokens: ${result.total_input_tokens + result.total_output_tokens}\n`;
            response += '\n';

            totalInputTokens += result.total_input_tokens;
            totalOutputTokens += result.total_output_tokens;
            totalCalls += result.call_count;
            totalExtendedHistory += result.extended_history_count;
            totalCachedTokens += (result.total_cached_tokens || 0);
            totalCost += (result.total_cost || 0);
        }

        if (showAllUsers) {
            response += '-------------------\n';
            response += 'Chat Totals:\n';
            response += `  Total Cost: $${totalCost.toFixed(4)}\n`;
            response += `  Total calls: ${totalCalls}\n`;
        }

        await client.sendMessage(message.from, response);

    } catch (error) {
        logger.error('Cmd', 'Error getting usage summary: ' + error.message);
        await client.sendMessage(message.from, 'Error retrieving usage data.');
    }
}

register('!usage', handler, { adminOnly: false });
