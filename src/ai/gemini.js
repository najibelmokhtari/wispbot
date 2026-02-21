const { prepareMessagesForClaude, replacePhoneNumbersWithUsernames } = require('../phone-number-replacer');
const { processMessageHistory } = require('../message-processor');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { calculateCost } = require('../pricing-config');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

// Initialize the Google Generative AI client
logger.debug('Gemini', 'Loading Gemini API Key...');
logger.debug('Gemini', `GEMINI_API_KEY present: ${!!GEMINI_API_KEY}`);
if (GEMINI_API_KEY) {
    logger.debug('Gemini', `GEMINI_API_KEY length: ${GEMINI_API_KEY.length}`);
    logger.debug('Gemini', `GEMINI_API_KEY suffix: ${GEMINI_API_KEY.slice(-4)}`);
} else {
    logger.error('Gemini', 'GEMINI_API_KEY is missing or undefined!');
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function callGeminiAPI(context, config, systemPrompt) {
    const userPrefixPrompt = await readPromptFile(path.join('prompts', 'system', 'user_prefix_prompt.txt'));

    const formattedMessages = processMessageHistory(context.recentMessages, config);
    let preparedMessages = prepareMessagesForClaude(formattedMessages);

    // Gemini API uses a different structure for history, so we build it here.
    // We will combine the system prompt with the user prefix and the recent messages.
    logger.debug('Gemini', 'System Prompt: ' + systemPrompt);

    const history = [
        {
            role: "user",
            parts: [{ text: systemPrompt }]
        },
        {
            role: "model",
            parts: [{ text: "Understood. I will act as the specified persona." }]
        }
    ];

    // Configure tools if search is enabled
    // We enable both Google Search (Grounding) and URL Context (Reading specific pages)
    const tools = [];
    if (context.googleSearchEnabled) {
        tools.push({ googleSearch: {} });
        tools.push({ urlContext: {} });
    }

    const modelName = config.aiModel || "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({
        model: modelName,
        tools: tools
    });

    const chat = model.startChat({
        history: history,
        generationConfig: {
            maxOutputTokens: 16000,
        }
    });

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
        logger.debug('Gemini', `Adding custom group context to prompt: ${context.groupCustomContext}`);
        userMessage += `\nCustom Group Context:\n${context.groupCustomContext}\n`;
    } else {
        logger.debug('Gemini', 'No custom group context available for this group');
    }

    // Add group memories (maintained by background processor)
    if (context.groupMemories) {
        logger.debug('Gemini', `Adding group memories to prompt (${context.groupMemories.length} chars)`);
        userMessage += `\nGroup Memories (auto-maintained background notes about this group):\n${context.groupMemories}\n`;
    }

    userMessage += `\nRecent messages:\n${preparedMessages}`;

    const username = replacePhoneNumbersWithUsernames(context.senderId);
    userMessage += `\n\nSystem Message: You are now responding to ${username}`;

    // Handle Quoted Media Notes
    if (context.quotedImageId) {
        userMessage += `\nNote: The user's message is in reply to an image with ID ${context.quotedImageId}.`;
    }

    if (context.quotedAudioId) {
        if (context.audioEnabled) {
            if (context.audioHistoryMode === 'tagged') {
                userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}. The audio content is attached to this request.`;
            } else {
                userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}.`;
            }
        } else {
            userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}, but audio processing is currently disabled for this group.`;
        }
    }

    // Handle Current Message Media Notes
    if (context.currentImageId) {
        userMessage += `\nNote: The user attached an image to this message (ID: ${context.currentImageId}).`;
    }

    if (context.currentAudioId) {
        if (context.audioEnabled) {
            userMessage += `\nNote: The user attached an audio message (ID: ${context.currentAudioId}) to this request.`;
        } else {
            userMessage += `\nNote: The user attached an audio message (ID: ${context.currentAudioId}), but audio processing is disabled.`;
        }
    }

    const msgParts = [
        { text: userMessage }
    ];

    // Helper to attach image part
    const attachImage = async (imageId) => {
        try {
            const imagePath = path.join(config.imageDirectory, `${imageId}.jpg`);
            const imageBase64 = await encodeImageToBase64(imagePath);
            msgParts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: imageBase64
                }
            });
        } catch (error) {
            logger.error('Gemini', 'Error processing image: ' + error.message);
            msgParts.push({ text: `\nNote: There was an error processing the image with ID ${imageId}.` });
        }
    };

    // Attach Quoted Image
    if (context.quotedImageId) {
        await attachImage(context.quotedImageId);
    }

    // Attach Current Image
    if (context.currentImageId) {
        await attachImage(context.currentImageId);
    }

    // Helper to attach audio part
    const attachAudio = async (audioId) => {
        try {
            const audioData = await getAudioData(config, audioId);
            if (audioData) {
                msgParts.push(audioData);
            } else {
                logger.error('Gemini', `Audio file for ID ${audioId} not found.`);
                msgParts.push({ text: `\nNote: The audio file with ID ${audioId} could not be found.` });
            }
        } catch (error) {
            logger.error('Gemini', 'Error processing audio: ' + error.message);
            msgParts.push({ text: `\nNote: There was an error processing the audio with ID ${audioId}.` });
        }
    };

    // Attach audio based on audio history mode
    if (context.audioEnabled) {
        if (context.audioHistoryMode === 'history') {
            // Collect audio IDs from recent messages (excluding current message's audio)
            const historyAudioIds = [];
            for (const msg of context.recentMessages) {
                if (msg.audio_id && msg.audio_id !== context.currentAudioId) {
                    historyAudioIds.push(msg.audio_id);
                }
            }
            // Take the last X audio IDs
            const count = context.audioHistoryCount || 1;
            const audioIdsToAttach = historyAudioIds.slice(-count);

            if (audioIdsToAttach.length > 0) {
                userMessage += `\nNote: The last ${audioIdsToAttach.length} audio message(s) from the conversation history are attached: ${audioIdsToAttach.join(', ')}.`;
                for (const audioId of audioIdsToAttach) {
                    await attachAudio(audioId);
                }
            }

            // Always attach current audio if present
            if (context.currentAudioId) {
                await attachAudio(context.currentAudioId);
            }
        } else {
            // Tagged mode: only attach quoted and current audio (original behavior)
            if (context.quotedAudioId) {
                await attachAudio(context.quotedAudioId);
            }
            if (context.currentAudioId) {
                await attachAudio(context.currentAudioId);
            }
        }
    }

    logger.debug('Gemini', 'User Message: ' + userMessage);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await chat.sendMessage(msgParts);
            const response = await result.response;
            logger.debug('Gemini', 'Gemini API Response Object: ' + JSON.stringify(response, null, 2));
            const text = response.text();

            // Extract usage metadata directly from the response
            const usage = response.usageMetadata || {};
            const inputTokens = usage.promptTokenCount || 0;
            const outputTokens = usage.candidatesTokenCount || 0;
            const cachedTokens = usage.cachedContentTokenCount || 0;

            // Calculate estimated cost
            const cost = calculateCost('google', modelName, inputTokens, outputTokens, cachedTokens);

            return {
                response: text,
                tokens: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    cached_tokens: cachedTokens,
                    cost_usd: cost,
                    provider: 'google'
                }
            };

        } catch (error) {
            logger.error('Gemini', `Error in Gemini API request (Attempt ${attempt}): ${error.message}`);
            if (attempt < MAX_RETRIES) {
                logger.info('Gemini', `Retrying in ${RETRY_DELAY / 1000} seconds...`);
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
        logger.error('Gemini', `Error reading ${filename}: ${error.message}`);
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
        logger.error('Gemini', `Error encoding image to base64: ${error.message}`);
        throw error;
    }
}

async function encodeAudioToBase64(audioPath) {
    try {
        const audioBuffer = await fs.readFile(audioPath);
        return audioBuffer.toString('base64');
    } catch (error) {
        logger.error('Gemini', `Error encoding audio to base64: ${error.message}`);
        throw error;
    }
}

// New helper function to find and encode audio
async function getAudioData(config, audioId) {
    const audioDir = config.audioDirectory;
    try {
        const files = await fs.readdir(audioDir);
        const audioFile = files.find(file => file.startsWith(audioId));

        if (audioFile) {
            const audioPath = path.join(audioDir, audioFile);
            const audioBase64 = await encodeAudioToBase64(audioPath);
            const ext = path.extname(audioFile).toLowerCase();
            let mimeType = 'audio/ogg';
            if (ext === '.mp3') mimeType = 'audio/mp3';
            if (ext === '.wav') mimeType = 'audio/wav';
            if (ext === '.m4a') mimeType = 'audio/mp4';

            return {
                inlineData: {
                    mimeType: mimeType,
                    data: audioBase64
                }
            };
        }
    } catch (error) {
        logger.error('Gemini', 'Error finding audio file: ' + error.message);
    }
    return null;
}

module.exports = { callGeminiAPI };