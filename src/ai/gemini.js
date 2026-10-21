const { prepareMessagesForClaude, replacePhoneNumbersWithUsernames } = require('../phone-number-replacer');
const { processMessageHistory } = require('../message-processor');
const { GoogleGenAI } = require('@google/genai');
const { calculateCost } = require('../pricing-config');
const { loadServiceAccount, getAuthMode } = require('./credentials');
const { ANALYZE_AUDIO_TOOL, analyzeAudio, loadAudioPart, formatDuration } = require('../services/audio-analysis');
const appConfig = require('../config');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

require('dotenv').config();

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const MAX_TOOL_ROUNDS = 3; // Tool call rounds per reply before the model must answer

// Shared Google GenAI client — authenticated with either a service account (Vertex AI) or an API key
let genAI = null;

function initializeGemini() {
    const mode = getAuthMode();
    if (mode === 'service_account') {
        const sa = loadServiceAccount();
        genAI = new GoogleGenAI({
            vertexai: true,
            project: sa.project_id,
            location: appConfig.vertexRegion,
            googleAuthOptions: {
                credentials: sa,
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            }
        });
        logger.info('Gemini', `Using service account ${sa.client_email} (Vertex AI, project: ${sa.project_id}, location: ${appConfig.vertexRegion})`);
    } else if (mode === 'api_key') {
        const apiKey = process.env.GEMINI_API_KEY;
        genAI = new GoogleGenAI({ apiKey });
        logger.info('Gemini', `Using Gemini API key (key suffix: ${apiKey.slice(-4)})`);
    } else {
        logger.warn('Gemini', 'No Gemini credentials configured — bot will not respond until configured via setup wizard.');
        genAI = null;
    }
}

// Re-initialize with a new API key (called from setup wizard)
function reinitializeGemini(newKey) {
    process.env.GEMINI_API_KEY = newKey;
    initializeGemini();
    logger.info('Gemini', 'Gemini client re-initialized.');
}

// Initial setup
initializeGemini();

async function callGeminiAPI(context, config, systemPrompt) {
    if (!genAI) {
        throw new Error('Gemini credentials not configured. Set GEMINI_API_KEY or GOOGLE_SERVICE_ACCOUNT_FILE.');
    }
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

    // Let the model listen to voice notes from this chat on demand
    const audioToolEnabled = context.audioEnabled && !!context.groupId;
    if (audioToolEnabled) {
        tools.push({ functionDeclarations: [ANALYZE_AUDIO_TOOL] });
    }

    const modelName = config.aiModel || "gemini-2.5-flash";
    const createChat = () => genAI.chats.create({
        model: modelName,
        history: history,
        config: {
            tools: tools,
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
        if (context.imageEnabled) {
            userMessage += `\nNote: The user's message is in reply to an image with ID ${context.quotedImageId}.`;
        } else {
            userMessage += `\nNote: The user's message is in reply to an image with ID ${context.quotedImageId}, but image processing is currently disabled for this group.`;
        }
    }

    if (context.quotedAudioId) {
        if (context.audioEnabled) {
            if (context.audioHistoryMode === 'tagged') {
                userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}. The audio content is attached to this request. See the "(Audio: ${context.quotedAudioId})" marker in the recent messages above for when it was sent.`;
            } else {
                userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}. See the "(Audio: ${context.quotedAudioId})" marker in the recent messages above for when it was sent.`;
            }
        } else {
            userMessage += `\nNote: The user's message is in reply to an audio message with ID ${context.quotedAudioId}, but audio processing is currently disabled for this group.`;
        }
    }

    // Handle Current Message Media Notes
    if (context.currentImageId) {
        if (context.imageEnabled) {
            userMessage += `\nNote: The user attached an image to this message (ID: ${context.currentImageId}).`;
        } else {
            userMessage += `\nNote: The user attached an image (ID: ${context.currentImageId}), but image processing is disabled.`;
        }
    }

    if (context.currentAudioId) {
        if (context.audioEnabled) {
            userMessage += `\nNote: The user's current message includes an audio message (ID: ${context.currentAudioId}). See the "(Audio: ${context.currentAudioId})" marker in the recent messages above for its exact position in the conversation timeline.`;
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

    // Attach images based on image history mode
    if (context.imageEnabled && context.imageHistoryMode === 'history') {
        // Collect image IDs from recent messages (excluding current message's image)
        const historyImageIds = [];
        for (const msg of context.recentMessages) {
            if (msg.imageId && msg.imageId !== context.currentImageId) {
                historyImageIds.push(msg.imageId);
            }
        }
        // Take the last X image IDs
        const imgCount = context.imageHistoryCount || 1;
        const imageIdsToAttach = historyImageIds.slice(-imgCount);

        if (imageIdsToAttach.length > 0) {
            userMessage += `\nNote: The last ${imageIdsToAttach.length} image(s) from the conversation history are attached: ${imageIdsToAttach.join(', ')}. Check the "(Image: <image_id>)" markers in the recent messages above to see exactly when each image was shared in the conversation timeline.`;
            for (const imageId of imageIdsToAttach) {
                await attachImage(imageId);
            }
        }

        // Always attach current image if present
        if (context.currentImageId) {
            await attachImage(context.currentImageId);
        }
    } else if (context.imageEnabled) {
        // Tagged mode: only attach quoted and current image (original behavior)
        if (context.quotedImageId) {
            await attachImage(context.quotedImageId);
        }
        if (context.currentImageId) {
            await attachImage(context.currentImageId);
        }
    }

    // Helper to attach audio part
    const attachAudio = async (audioId) => {
        try {
            // Trimmed to the hard cap (AUDIO_ANALYSIS_MAX_SECONDS)
            const audioData = await loadAudioPart(audioId);
            if (audioData) {
                msgParts.push(audioData.part);
                if (audioData.truncated && audioData.duration) {
                    msgParts.push({ text: `
Note: only the first ${formatDuration(appConfig.audioAnalysisMaxSeconds)} of the ${formatDuration(audioData.duration)} audio ${audioId} are attached.` });
                }
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
                userMessage += `\nNote: The last ${audioIdsToAttach.length} audio message(s) from the conversation history are attached: ${audioIdsToAttach.join(', ')}. Check the "(Audio: <audio_id>)" markers in the recent messages above to see exactly when each audio was sent in the conversation timeline.`;
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
            // Fresh chat per attempt so a failed tool round doesn't leave partial history behind
            const chat = createChat();
            let inputTokens = 0, outputTokens = 0, cachedTokens = 0, toolCost = 0;
            const addUsage = (res) => {
                const usage = res.usageMetadata || {};
                inputTokens += usage.promptTokenCount || 0;
                outputTokens += usage.candidatesTokenCount || 0;
                cachedTokens += usage.cachedContentTokenCount || 0;
            };

            let response = await chat.sendMessage({ message: msgParts });
            addUsage(response);

            // Tool loop: run requested function calls and send the results back
            for (let round = 1; response.functionCalls && response.functionCalls.length > 0; round++) {
                const lastRound = round > MAX_TOOL_ROUNDS;
                const resultParts = [];
                for (const call of response.functionCalls) {
                    let result;
                    if (lastRound) {
                        result = { error: 'Tool call limit reached. Answer now with the information you already have.' };
                    } else if (call.name === ANALYZE_AUDIO_TOOL.name && audioToolEnabled) {
                        logger.info('Gemini', `Tool call: analyze_audio ${JSON.stringify(call.args)}`);
                        const out = await analyzeAudio(context.groupId, call.args);
                        toolCost += out.costUsd;
                        result = out.response;
                    } else {
                        result = { error: `Unknown tool ${call.name}` };
                    }
                    resultParts.push({ functionResponse: { id: call.id, name: call.name, response: result } });
                }
                response = await chat.sendMessage({ message: resultParts });
                addUsage(response);
                if (lastRound) break;
            }

            logger.debug('Gemini', 'Gemini API Response Object: ' + JSON.stringify(response, null, 2));
            const text = response.text || '';

            // Calculate estimated cost (main model across all rounds + audio tool calls)
            const cost = calculateCost('google', modelName, inputTokens, outputTokens, cachedTokens) + toolCost;

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

function getGenAI() {
    return genAI;
}

module.exports = { callGeminiAPI, reinitializeGemini, getGenAI };