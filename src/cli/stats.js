#!/usr/bin/env node
/**
 * CLI Script: stats.js
 * Server-side script to view usage statistics (similar to !usage command)
 * 
 * Usage:
 *   node cli/stats.js                    # Show today's stats (all groups)
 *   node cli/stats.js --today            # Show today's stats
 *   node cli/stats.js --week             # Show last 7 days stats
 *   node cli/stats.js --month            # Show last 30 days stats
 *   node cli/stats.js --all              # Show all-time stats
 *   node cli/stats.js --group <group_id> # Filter by specific group
 *   node cli/stats.js --user <user_id>   # Filter by specific user
 */

const { getDatabase, closeDatabase } = require('../db');

const args = process.argv.slice(2);

function parseArgs() {
    const options = {
        period: 'today',
        groupId: null,
        userId: null,
        startDate: null,
        endDate: null
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--today':
                options.period = 'today';
                break;
            case '--week':
                options.period = 'week';
                break;
            case '--month':
                options.period = 'month';
                break;
            case '--all':
                options.period = 'all';
                break;
            case '--from':
                options.startDate = args[++i];
                options.period = 'custom';
                break;
            case '--to':
                options.endDate = args[++i];
                options.period = 'custom';
                break;
            case '--group':
                options.groupId = args[++i];
                break;
            case '--user':
                options.userId = args[++i];
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
Usage Statistics CLI

Usage:
  node cli/stats.js [options]

Options:
  --today         Show today's stats (default)
  --week          Show last 7 days stats
  --month         Show last 30 days stats
  --all           Show all-time stats
  --from <date>   Start date (YYYY-MM-DD)
  --to <date>     End date (YYYY-MM-DD)
  --group <id>    Filter by specific group ID
  --user <id>     Filter by specific user ID
  --help, -h      Show this help message

Examples:
  node cli/stats.js --week
  node cli/stats.js --all --group 123456789012345678@g.us
  node cli/stats.js --from 2024-01-01 --to 2024-01-31
`);
}

function getDateRange(options) {
    const now = new Date();

    if (options.period === 'custom') {
        let start = options.startDate ? new Date(options.startDate) : new Date(0); // Default to epoch
        let end = options.endDate ? new Date(options.endDate) : new Date(); // Default to now

        // If end date is YYYY-MM-DD (length 10), make it end of day
        if (options.endDate && options.endDate.length === 10) {
            end.setHours(23, 59, 59, 999);
        }

        return {
            startDate: start.toISOString(),
            endDate: end.toISOString()
        };
    }

    const endDate = now.toISOString();
    let startDate;

    switch (options.period) {
        case 'today':
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            startDate = todayStart.toISOString();
            break;
        case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            startDate = weekAgo.toISOString();
            break;
        case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            startDate = monthAgo.toISOString();
            break;
        case 'all':
            startDate = '1970-01-01T00:00:00.000Z';
            break;
        default:
            const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            startDate = defaultStart.toISOString();
    }

    return { startDate, endDate };
}

function formatCost(cost) {
    return `$${(cost || 0).toFixed(4)}`;
}

function formatTokens(tokens) {
    if (!tokens) return '0';
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
}

async function main() {
    const options = parseArgs();
    const { startDate, endDate } = getDateRange(options);

    console.log('\n' + '='.repeat(60));
    console.log('📊 USAGE STATISTICS');
    console.log('='.repeat(60));
    console.log(`Period: ${options.period.toUpperCase()}`);
    console.log(`From: ${startDate}`);
    console.log(`To:   ${endDate}`);
    if (options.groupId) console.log(`Group: ${options.groupId}`);
    if (options.userId) console.log(`User:  ${options.userId}`);
    console.log('='.repeat(60) + '\n');

    try {
        const db = await getDatabase();

        // Build query
        let whereConditions = ['timestamp BETWEEN ? AND ?'];
        let queryParams = [startDate, endDate];

        if (options.groupId) {
            whereConditions.push('group_id = ?');
            queryParams.push(options.groupId);
        }
        if (options.userId) {
            whereConditions.push('user_id = ?');
            queryParams.push(options.userId);
        }

        const whereClause = whereConditions.join(' AND ');

        // Overall stats
        const overallStats = await db.get(`
            SELECT 
                COUNT(*) as total_calls,
                SUM(input_tokens) as total_input,
                SUM(output_tokens) as total_output,
                SUM(cached_tokens) as total_cached,
                SUM(cost_usd) as total_cost,
                SUM(CASE WHEN extended_history_used THEN 1 ELSE 0 END) as extended_history_count
            FROM llm_api_calls
            WHERE ${whereClause}
        `, queryParams);

        console.log('📈 OVERALL SUMMARY');
        console.log('-'.repeat(40));
        console.log(`Total API Calls:    ${overallStats.total_calls || 0}`);
        console.log(`Input Tokens:       ${formatTokens(overallStats.total_input)}`);
        console.log(`Output Tokens:      ${formatTokens(overallStats.total_output)}`);
        console.log(`Cached Tokens:      ${formatTokens(overallStats.total_cached)}`);
        console.log(`Extended History:   ${overallStats.extended_history_count || 0} calls`);
        console.log(`💰 TOTAL COST:      ${formatCost(overallStats.total_cost)}`);
        console.log();

        // Stats by group
        const groupStats = await db.all(`
            SELECT 
                group_id,
                COUNT(*) as calls,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cost_usd) as cost
            FROM llm_api_calls
            WHERE ${whereClause}
            GROUP BY group_id
            ORDER BY cost DESC
        `, queryParams);

        if (groupStats.length > 0) {
            console.log('📱 USAGE BY GROUP');
            console.log('-'.repeat(60));
            console.log('Group ID'.padEnd(35) + 'Calls'.padStart(8) + 'Cost'.padStart(12));
            console.log('-'.repeat(60));

            for (const group of groupStats) {
                const groupId = (group.group_id || 'Unknown').substring(0, 32);
                console.log(
                    groupId.padEnd(35) +
                    String(group.calls).padStart(8) +
                    formatCost(group.cost).padStart(12)
                );
            }
            console.log();
        }

        // Stats by user (top 10)
        const userStats = await db.all(`
            SELECT 
                c.user_id,
                u.whatsapp_name,
                u.custom_alias,
                COUNT(*) as calls,
                SUM(c.input_tokens) as input_tokens,
                SUM(c.output_tokens) as output_tokens,
                SUM(c.cost_usd) as cost
            FROM llm_api_calls c
            LEFT JOIN users u ON c.user_id = u.user_id
            WHERE ${whereClause.replace(/c\./g, '')}
            GROUP BY c.user_id
            ORDER BY cost DESC
            LIMIT 10
        `, queryParams);

        if (userStats.length > 0) {
            console.log('👤 TOP USERS BY COST');
            console.log('-'.repeat(70));
            console.log('User'.padEnd(30) + 'Calls'.padStart(8) + 'Input'.padStart(12) + 'Output'.padStart(12) + 'Cost'.padStart(10));
            console.log('-'.repeat(70));

            for (const user of userStats) {
                const userName = user.custom_alias || user.whatsapp_name || user.user_id.substring(0, 15);
                console.log(
                    userName.substring(0, 28).padEnd(30) +
                    String(user.calls).padStart(8) +
                    formatTokens(user.input_tokens).padStart(12) +
                    formatTokens(user.output_tokens).padStart(12) +
                    formatCost(user.cost).padStart(10)
                );
            }
            console.log();
        }

        // Stats by model
        const modelStats = await db.all(`
            SELECT 
                ai_model,
                provider,
                COUNT(*) as calls,
                SUM(cost_usd) as cost
            FROM llm_api_calls
            WHERE ${whereClause}
            GROUP BY ai_model
            ORDER BY cost DESC
        `, queryParams);

        if (modelStats.length > 0) {
            console.log('🤖 USAGE BY MODEL');
            console.log('-'.repeat(50));
            console.log('Model'.padEnd(30) + 'Calls'.padStart(10) + 'Cost'.padStart(10));
            console.log('-'.repeat(50));

            for (const model of modelStats) {
                console.log(
                    (model.ai_model || 'Unknown').padEnd(30) +
                    String(model.calls).padStart(10) +
                    formatCost(model.cost).padStart(10)
                );
            }
            console.log();
        }

        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    } finally {
        await closeDatabase();
    }
}

main();
