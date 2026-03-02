#!/usr/bin/env node
/**
 * CLI Script: groups.js
 * Server-side script to list and manage groups
 * 
 * Usage:
 *   node cli/groups.js list              # List all groups
 *   node cli/groups.js info <group_id>   # Show details for a specific group
 *   node cli/groups.js set <group_id> <key> <value> # Update a setting
 * 
 * Examples:
 *   node cli/groups.js set 123@g.us ai_model gemini-2.5-flash
 *   node cli/groups.js set 123@g.us authorization_check_enabled 0
 */

const { getDatabase, closeDatabase, updateGroupInfo } = require('../db');

const args = process.argv.slice(2);
const command = args[0] || 'list';

async function main() {
    try {
        const db = await getDatabase();

        if (command === 'list') {
            const groups = await db.all('SELECT * FROM group_info');
            console.log('\n📱 REGISTERED GROUPS');
            console.log('='.repeat(100));
            console.log(
                'Group ID'.padEnd(30) +
                'Name'.padEnd(30) +
                'Model'.padEnd(20) +
                'Auth'.padEnd(6) +
                'Srch'.padEnd(6) +
                'TTS'
            );
            console.log('-'.repeat(100));

            for (const group of groups) {
                console.log(
                    group.group_id.substring(0, 28).padEnd(30) +
                    (group.group_name || 'Unknown').substring(0, 28).padEnd(30) +
                    (group.ai_model || 'default').substring(0, 18).padEnd(20) +
                    (group.authorization_check_enabled ? 'ON' : 'OFF').padEnd(6) +
                    (group.google_search_enabled ? 'ON' : 'OFF').padEnd(6) +
                    (group.tts_enabled ? 'ON' : 'OFF')
                );
            }
            console.log('='.repeat(100) + '\n');

        } else if (command === 'info') {
            const groupId = args[1];
            if (!groupId) {
                console.error('Error: Please provide a group ID');
                process.exit(1);
            }

            const group = await db.get('SELECT * FROM group_info WHERE group_id = ?', groupId);
            if (!group) {
                console.error(`Error: Group ${groupId} not found`);
                process.exit(1);
            }

            console.log('\nℹ️  GROUP DETAILS');
            console.log('='.repeat(50));
            console.log(`ID:        ${group.group_id}`);
            console.log(`Name:      ${group.group_name}`);
            console.log(`Model:     ${group.ai_model}`);
            console.log(`Prompt:    ${group.default_prompt_name}`);
            console.log(`Auth Check:${group.authorization_check_enabled ? ' ✅ Enabled' : ' ❌ Disabled'}`);
            console.log(`Search:    ${group.google_search_enabled ? ' ✅ Enabled' : ' ❌ Disabled'}`);
            console.log(`Audio:     ${group.audio_enabled ? ' ✅ Enabled' : ' ❌ Disabled'}`);
            console.log(`Image:     ${group.image_enabled ? ' ✅ Enabled' : ' ❌ Disabled'}`);
            console.log(`TTS:       ${group.tts_enabled ? ' ✅ Enabled' : ' ❌ Disabled'}`);
            console.log(`Last Active: ${group.last_processed_timestamp || 'Never'}`);

            console.log('\nTo update settings:');
            console.log(`node cli/groups.js set ${groupId} <setting> <value>`);
            console.log('='.repeat(50) + '\n');

        } else if (command === 'set') {
            const groupId = args[1];
            const key = args[2];
            const value = args[3];

            if (!groupId || !key || value === undefined) {
                console.error('Usage: node cli/groups.js set <group_id> <key> <value>');
                process.exit(1);
            }

            // Validate key
            const validKeys = [
                'ai_model',
                'default_prompt_name',
                'authorization_check_enabled',
                'google_search_enabled',
                'audio_enabled',
                'image_enabled',
                'tts_enabled'
            ];

            if (!validKeys.includes(key)) {
                console.error(`Error: Invalid setting '${key}'. Valid keys: ${validKeys.join(', ')}`);
                process.exit(1);
            }

            // Convert boolean-like strings to integers
            let dbValue = value;
            if (['authorization_check_enabled', 'google_search_enabled', 'audio_enabled', 'image_enabled', 'tts_enabled'].includes(key)) {
                if (value === 'true' || value === '1' || value === 'on') dbValue = 1;
                else if (value === 'false' || value === '0' || value === 'off') dbValue = 0;
                else {
                    console.error('Error: Value must be 0/1 or true/false for boolean settings');
                    process.exit(1);
                }
            }

            const updateData = {};
            updateData[key] = dbValue;

            await updateGroupInfo(groupId, updateData);
            console.log(`✅ Successfully updated ${key} to ${dbValue} for group ${groupId}`);

        } else {
            console.log(`
Group Management CLI

Usage:
  node cli/groups.js list              # List all groups
  node cli/groups.js info <group_id>   # Show details for a specific group
  node cli/groups.js set <group_id> <key> <value> # Update a setting

Valid Settings for 'set':
  - ai_model (e.g., "gemini-2.5-pro", "gemini-2.5-flash")
  - default_prompt_name
  - authorization_check_enabled (0/1)
  - google_search_enabled (0/1)
  - audio_enabled (0/1)
  - image_enabled (0/1)
  - tts_enabled (0/1)
`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await closeDatabase();
    }
}

main();
