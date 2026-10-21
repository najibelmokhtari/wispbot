const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');
const { replacePhoneNumbersWithUsernames } = require('../phone-number-replacer');
const { formatAudioMarker } = require('../message-processor');

/**
 * Memory extraction handler for the background processor.
 * Maintains a per-group markdown file with key facts, people, topics, etc.
 */
async function memoriesHandler(groupId, messages, ctx) {
    const { config, groupInfo, modelName, genAI, calculateCost, tokenUsageTracker } = ctx;

    const memoriesDir = config.memoriesDirectory;
    const memoriesPath = path.join(memoriesDir, `${groupId}.md`);

    // Ensure directory exists
    await fs.mkdir(memoriesDir, { recursive: true });

    // Load existing memories
    let existingMemories = '';
    try {
        existingMemories = await fs.readFile(memoriesPath, 'utf-8');
    } catch {
        // File doesn't exist yet — first run for this group
    }

    // Load system prompt
    let systemPrompt = '';
    try {
        systemPrompt = await fs.readFile(
            path.join(__dirname, '..', '..', 'prompts', 'system', 'background_memories_instruction.txt'),
            'utf-8'
        );
    } catch (err) {
        logger.error('Memories', `Could not load background_memories_instruction.txt: ${err.message}`);
        return;
    }

    // Format messages for the LLM
    const formattedMessages = messages.map(msg => {
        const sender = replacePhoneNumbersWithUsernames(msg.sender_id || msg.sender);
        const displayName = msg.sender || sender;
        return `${msg.timestamp} - ${displayName}: ${msg.message || ''}${msg.audio_id ? formatAudioMarker(msg) : ''}`;
    }).join('\n');

    // Build the prompt
    const userMessage = [
        `Group: ${groupInfo.group_name}`,
        '',
        '## Current Memories',
        existingMemories || '(No existing memories yet)',
        '',
        '## New Messages to Process',
        formattedMessages
    ].join('\n');

    // Call LLM
    try {
        const chat = genAI.chats.create({
            model: modelName,
            history: [
                { role: 'user', parts: [{ text: systemPrompt }] },
                { role: 'model', parts: [{ text: 'Understood. I will maintain the group memories document as instructed.' }] }
            ],
            config: { maxOutputTokens: 8000 }
        });

        const response = await chat.sendMessage({ message: [{ text: userMessage }] });
        const updatedMemories = response.text;

        if (!updatedMemories || updatedMemories.trim().length === 0) {
            logger.warn('Memories', `Empty response from LLM for ${groupId}, skipping write`);
            return;
        }

        // Write updated memories
        await fs.writeFile(memoriesPath, updatedMemories, 'utf-8');
        logger.info('Memories', `Updated memories for ${groupId} (${updatedMemories.length} chars)`);

        // Track token usage
        const usage = response.usageMetadata || {};
        const inputTokens = usage.promptTokenCount || 0;
        const outputTokens = usage.candidatesTokenCount || 0;
        const cachedTokens = usage.cachedContentTokenCount || 0;
        const cost = calculateCost('google', modelName, inputTokens, outputTokens, cachedTokens);

        await tokenUsageTracker.recordUsage(
            'background-processor',
            groupId,
            inputTokens,
            outputTokens,
            false,
            modelName,
            cachedTokens,
            cost,
            'google'
        );

        logger.debug('Memories', `Tokens: ${inputTokens} in / ${outputTokens} out, cost: $${cost.toFixed(6)}`);
    } catch (err) {
        logger.error('Memories', `LLM call failed for ${groupId}: ${err.message}`);
    }
}

module.exports = memoriesHandler;
