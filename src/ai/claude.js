const { prepareMessagesForClaude, replacePhoneNumbersWithUsernames } = require('../phone-number-replacer');
const { processMessageHistory, removeExtendedHistoryCode } = require('../message-processor');

require('dotenv').config();
const fs = require('fs').promises;
const axios = require('axios');
const path = require('path');
const logger = require('../logger');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function callClaudeAPI(context, config, systemPrompt) {
    const userPrefixPrompt = await readPromptFile(path.join('prompts', 'system', 'user_prefix_prompt.txt'));

    const formattedMessages = processMessageHistory(context.recentMessages, config);
    let preparedMessages = prepareMessagesForClaude(formattedMessages);

    let userMessage = `${userPrefixPrompt}\n\nGroup Name: ${context.groupName}\n`;

    // Add group participants list (name-based, no raw IDs)
    if (context.groupParticipants && context.groupParticipants.length > 0) {
        // Detect duplicate aliases and disambiguate
        const aliasCounts = new Map();
        for (const p of context.groupParticipants) {
            const key = p.alias.toLowerCase().trim();
            aliasCounts.set(key, (aliasCounts.get(key) || 0) + 1);
        }
        const aliasCounters = new Map();

        userMessage += `\nGroup Participants:\n`;
        // Sort by userId for deterministic disambiguator numbering
        const sorted = [...context.groupParticipants].sort((a, b) => a.userId.localeCompare(b.userId));
        for (const participant of sorted) {
            const key = participant.alias.toLowerCase().trim();
            let displayName = participant.alias;
            if (aliasCounts.get(key) > 1) {
                const idx = (aliasCounters.get(key) || 0) + 1;
                aliasCounters.set(key, idx);
                displayName = `${participant.alias} #${idx}`;
            }
            participant.alias = displayName; // Update for resolveMentions() downstream
            userMessage += `- ${displayName}\n`;
        }
    }

    // Add custom group context if available
    if (context.groupCustomContext) {
        userMessage += `\nCustom Group Context:\n${context.groupCustomContext}\n`;
    }

    userMessage += `\nRecent messages:\n${preparedMessages}`;

    const username = replacePhoneNumbersWithUsernames(context.senderId);
    userMessage += `\n\nSystem Message: You are now responding to ${username}`;

    if (context.quotedImageId) {
        userMessage += `\nNote: The user's message is in reply to an image with ID ${context.quotedImageId}.`;
    }

    if (context.currentImageId) {
        userMessage += `\nNote: The user attached an image to this message (ID: ${context.currentImageId}).`;
    }

    logger.debug('Claude', 'User message: ' + userMessage);

    const userContent = [];

    // Helper to add image content
    const addImageContent = async (imageId) => {
        try {
            const imagePath = path.join(config.imageDirectory, `${imageId}.jpg`);
            const imageBase64 = await encodeImageToBase64(imagePath);
            userContent.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: imageBase64,
                }
            });
            userMessage += `\nThe image (ID: ${imageId}) has been attached to this message for your analysis.`;
        } catch (error) {
            logger.error('Claude', 'Error processing image: ' + error.message);
            userMessage += `\nNote: There was an error processing the image with ID ${imageId}.`;
        }
    };

    // Add image if present in context (quoted)
    if (context.quotedImageId) {
        await addImageContent(context.quotedImageId);
    }

    // Add image if present in context (current)
    if (context.currentImageId) {
        await addImageContent(context.currentImageId);
    }

    // Add text content
    userContent.push({
        type: 'text',
        text: userMessage
    });

    const messages = [
        { role: 'user', content: userContent }
    ];

    logger.debug('Claude', 'API Request - System Prompt: ' + systemPrompt);
    logger.debug('Claude', 'API Request - Messages: ' + JSON.stringify(messages, null, 2));

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.post(CLAUDE_API_URL, {
                model: config.aiModel,
                system: systemPrompt,
                messages: messages,
                max_tokens: 1000
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CLAUDE_API_KEY,
                    'anthropic-version': '2023-06-01'
                }
            });

            logger.debug('Claude', `API Response (Attempt ${attempt}): ${JSON.stringify(response.data, null, 2)}`);

            if (response.data && response.data.content && Array.isArray(response.data.content) && response.data.content.length > 0) {
                const content = response.data.content[0];
                if (content.type === 'text' && content.text) {
                    if (response.data.usage && response.data.usage.input_tokens !== undefined && response.data.usage.output_tokens !== undefined) {
                        return {
                            response: content.text,
                            tokens: {
                                prompt_tokens: response.data.usage.input_tokens,
                                completion_tokens: response.data.usage.output_tokens
                            }
                        };
                    } else {
                        logger.error('Claude', 'Token usage information missing in API response: ' + JSON.stringify(response.data, null, 2));
                        return {
                            response: content.text,
                            tokens: undefined
                        };
                    }
                }
            }

            logger.error('Claude', `Unexpected API response structure (Attempt ${attempt}): ${JSON.stringify(response.data, null, 2)}`);

            if (attempt < MAX_RETRIES) {
                logger.info('Claude', `Retrying in ${RETRY_DELAY / 1000} seconds...`);
                await sleep(RETRY_DELAY);
            }
        } catch (error) {
            logger.error('Claude', `Error in Claude API request (Attempt ${attempt}): ${error.message}`);
            if (error.response) {
                logger.error('Claude', 'Error response: ' + JSON.stringify(error.response.data));
            }

            if (attempt < MAX_RETRIES) {
                logger.info('Claude', `Retrying in ${RETRY_DELAY / 1000} seconds...`);
                await sleep(RETRY_DELAY);
            } else {
                throw error;
            }
        }
    }

    throw new Error(`Failed to get a valid response after ${MAX_RETRIES} attempts`);
}

async function readPromptFile(filename) {
    try {
        return await fs.readFile(filename, 'utf-8');
    } catch (error) {
        logger.error('Claude', `Error reading ${filename}: ${error.message}`);
        return '';
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function encodeImageToBase64(imagePath) {
    try {
        const imageBuffer = await fs.readFile(imagePath);
        return imageBuffer.toString('base64');
    } catch (error) {
        logger.error('Claude', `Error encoding image to base64: ${error.message}`);
        throw error;
    }
}

module.exports = { callClaudeAPI };