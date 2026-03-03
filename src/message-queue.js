const { callGeminiAPI } = require('./ai/gemini');
const { removeExtendedHistoryCode } = require('./message-processor');
const TokenUsageTracker = require('./token-usage-tracker');
const conversationStore = require('./conversation-store');
const { getDatabase, getOrCreateGroupInfo, updateGroupInfo, getUserAlias, getBotSetting } = require('./db');
const fs = require('fs').promises;
const path = require('path');
const { dbIdToJid } = require('./whatsapp-utils');
const TTSService = require('./services/tts');
const logger = require('./logger');
const { parsePersonaFile } = require('./persona-parser');

/**
 * Provider registry — add new LLM providers here.
 * Each provider function must match the signature:
 *   (context, config, systemPrompt) => Promise<{ response: string, tokens: { prompt_tokens, completion_tokens, cached_tokens?, cost_usd?, provider? } }>
 */
const AI_PROVIDERS = {
    gemini: callGeminiAPI,
};

function getAiApi(provider) {
    const fn = AI_PROVIDERS[provider];
    if (!fn) {
        throw new Error(`AI provider "${provider}" is not implemented. Available providers: ${Object.keys(AI_PROVIDERS).join(', ')}`);
    }
    return fn;
}

// Helper function to introduce a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class PromptManager {
    constructor() {
        this.prompts = new Map();
        this.ttsStylePrompts = new Map();
        this.ttsVoices = new Map();
        this.baseInstructions = '';
    }

    async loadPrompts() {
        // Load base instructions that are prepended to every persona
        try {
            this.baseInstructions = await fs.readFile(path.join(__dirname, '..', 'prompts', 'system', 'base_instructions.txt'), 'utf-8');
        } catch (error) {
            logger.error('Queue', 'Error loading base_instructions.txt: ' + error.message);
        }

        const promptsDir = path.join(__dirname, '..', 'prompts', 'personas');
        try {
            await fs.mkdir(promptsDir, { recursive: true });

            const files = await fs.readdir(promptsDir);
            for (const file of files) {
                if (!file.endsWith('.persona')) continue;
                const name = file.slice(0, -8); // strip '.persona'
                const raw = await fs.readFile(path.join(promptsDir, file), 'utf-8');
                const persona = parsePersonaFile(raw);
                if (persona.systemPrompt) this.prompts.set(name, persona.systemPrompt);
                if (persona.voice) this.ttsVoices.set(name, persona.voice);
                if (persona.ttsStyle) this.ttsStylePrompts.set(name, persona.ttsStyle);
            }
        } catch (error) {
            logger.error('Queue', 'Error loading prompts: ' + error.message);
        }
    }

    getTtsStylePrompt(promptName) {
        return this.ttsStylePrompts.get(promptName) || null;
    }

    getTtsVoice(promptName) {
        return this.ttsVoices.get(promptName) || this.ttsVoices.get('default') || null;
    }

    getPrompt(promptName) {
        const persona = this.prompts.get(promptName);
        if (persona) {
            return this.baseInstructions + '\n\n' + persona;
        }
        // No persona selected (or 'default') — just use base instructions
        return this.baseInstructions || 'You are a helpful AI assistant.';
    }

    async reloadPrompt(promptName) {
        if (promptName === 'base') {
            try {
                this.baseInstructions = await fs.readFile(path.join(__dirname, '..', 'prompts', 'system', 'base_instructions.txt'), 'utf-8');
            } catch (error) {
                logger.error('Queue', `Error reloading base instructions: ${error.message}`);
                return false;
            }
            // Also reload default persona (voice + tts style)
            return this.reloadPrompt('default');
        }
        const promptsDir = path.join(__dirname, '..', 'prompts', 'personas');
        const filePath = path.join(promptsDir, `${promptName}.persona`);
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            const persona = parsePersonaFile(raw);
            // Update or clear each map entry
            if (persona.systemPrompt) this.prompts.set(promptName, persona.systemPrompt);
            else this.prompts.delete(promptName);
            if (persona.voice) this.ttsVoices.set(promptName, persona.voice);
            else this.ttsVoices.delete(promptName);
            if (persona.ttsStyle) this.ttsStylePrompts.set(promptName, persona.ttsStyle);
            else this.ttsStylePrompts.delete(promptName);
            return true;
        } catch (error) {
            logger.error('Queue', `Error reloading prompt ${promptName}: ${error.message}`);
            return false;
        }
    }
}

class MessageQueueManager {
    constructor(config) {
        this.config = config;
        this.processingFlag = false;
        this.messageQueue = [];
        this.batchTimer = null;
        this.batchTimeout = 2000; // 2 seconds
        this.tokenUsageTracker = new TokenUsageTracker(config);
        this.promptManager = new PromptManager();
        this.defaultPromptName = 'default';
        this.ttsService = new TTSService();
    }

    async initialize() {
        await getDatabase();
        await conversationStore.initialize();
        await this.tokenUsageTracker.initialize();
        await this.promptManager.loadPrompts();
    }

    async queueMessage(client, message, historyLimit) {
        // Backpressure: reject if queue is too deep (Phase 5)
        if (this.messageQueue.length >= 50) {
            try {
                await client.sendMessage(message.from, '⚠️ The bot is currently busy processing many messages. Please try again in a moment.');
            } catch (e) {
                logger.error('Queue', `Failed to send busy reply: ${e.message}`);
            }
            return;
        }

        this.messageQueue.push({ client, message, botResponse: null, historyLimit });

        if (!this.processingFlag && !this.batchTimer) {
            this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
        }
    }

    // --- HELPER: Resolve Mentions ---
    async resolveMentions(client, text, participants = []) {
        // Handle null/undefined text
        if (!text || typeof text !== 'string') {
            return { formattedText: '', mentions: [] };
        }

        const mentions = [];
        const seenIds = new Set();
        let formattedText = text;

        // Pass 1: Legacy ID format — @number@c.us or @number@lid
        const idRegex = /@(\d+(@c\.us|@lid))/g;
        let match;
        while ((match = idRegex.exec(text)) !== null) {
            const fullId = match[1];
            seenIds.add(fullId);
        }
        for (const id of seenIds) {
            mentions.push(id);
        }
        idRegex.lastIndex = 0;
        formattedText = formattedText.replace(idRegex, (match, fullId) => {
            const number = fullId.split('@')[0];
            return `@${number}`;
        });

        // Pass 2: Name-based format — @[Name]
        // Build a lookup map: lowercased alias → list of participants with that alias
        const aliasMap = new Map();
        for (const p of participants) {
            const key = p.alias.toLowerCase().trim();
            if (!aliasMap.has(key)) {
                aliasMap.set(key, []);
            }
            aliasMap.get(key).push(p);
        }

        // Helper to resolve a name against the alias map
        const resolveNameMention = (name) => {
            const key = name.toLowerCase().trim();
            const matches = aliasMap.get(key);
            if (!matches || matches.length !== 1) {
                // No match or ambiguous — no mention
                return null;
            }
            const participant = matches[0];
            if (!seenIds.has(participant.userId)) {
                seenIds.add(participant.userId);
                mentions.push(participant.userId);
            }
            return participant.userId.split('@')[0];
        };

        // Pass 2: Bracketed format — @[Name]
        formattedText = formattedText.replace(/@\[([^\]]+)\]/g, (match, name) => {
            const number = resolveNameMention(name);
            return number ? `@${number}` : `@${name}`;
        });

        // Pass 3: Bare @Name fallback — match against known participant names
        // Sort names longest-first to avoid partial matches (e.g., "@Amine HAMMADI" before "@Amine")
        if (participants.length > 0) {
            const sortedNames = participants
                .map(p => p.alias)
                .sort((a, b) => b.length - a.length);
            // Build a regex that matches @Name where Name is a known participant
            // Word boundary or end-of-string after the name to avoid partial matches
            const escapedNames = sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const bareNameRegex = new RegExp(`@(${escapedNames.join('|')})(?=\\s|[.,!?;:)]|$)`, 'gi');
            formattedText = formattedText.replace(bareNameRegex, (match, name) => {
                const number = resolveNameMention(name);
                return number ? `@${number}` : match;
            });
        }

        return { formattedText, mentions };
    }
    // ------------------------------------

    /**
     * Parses an LLM response for TTS into [RESPONSE] and [TTS_STYLE] sections.
     * Returns an object with { content, stylePrompt }.
     * Falls back to using the full response as content if parsing fails.
     */
    parseTTSResponse(response) {
        const responseMatch = response.match(/\[RESPONSE\]([\s\S]*?)(?:\[TTS_STYLE\]|$)/);
        const styleMatch = response.match(/\[TTS_STYLE\]([\s\S]*?)$/);

        if (responseMatch && styleMatch) {
            return {
                content: responseMatch[1].trim(),
                stylePrompt: styleMatch[1].trim()
            };
        }

        // Fallback: use full response as content, no custom style
        logger.warn('TTS', 'Failed to parse structured TTS response, using fallback');
        return {
            content: response.trim(),
            stylePrompt: null
        };
    }
    // ------------------------------------

    async processBatch() {
        if (this.processingFlag || this.messageQueue.length === 0) {
            return;
        }

        this.processingFlag = true;
        this.batchTimer = null;

        const batchMessages = [...this.messageQueue];
        this.messageQueue = [];

        for (let i = 0; i < batchMessages.length; i++) {
            const { client, message, historyLimit } = batchMessages[i];
            const groupId = message.from;
            const senderId = message.author || message.from; // Safe sender ID retrieval

            let aiModel = this.config.aiModel; // default; updated below with group-specific model
            try {
                let chatHistory = await conversationStore.loadConversation(groupId, historyLimit);

                // We iterate backwards to find the latest clear command
                for (let j = chatHistory.length - 1; j >= 0; j--) {
                    if (chatHistory[j].message === 'Clearing history...') {
                        // Slice the array to keep only messages AFTER this marker
                        chatHistory = chatHistory.slice(j + 1);
                        logger.info('Queue', `Applied clear command for ${groupId}. New history length: ${chatHistory.length}`);
                        break;
                    }
                }

                const context = await this.prepareContext(message, chatHistory);
                const groupInfo = await getOrCreateGroupInfo(groupId, message.groupInfo?.name || message.dmContactName || 'Unknown Group');

                // Skip AI for inactive (unconfigured) groups
                if (!groupInfo.is_active) {
                    logger.debug('Queue', `Skipping AI for inactive group ${groupId}`);
                    continue;
                }

                // Pass the search enabled flag to the context
                context.googleSearchEnabled = groupInfo.google_search_enabled === 1;

                // --- TTS INTENT DETECTION ---
                const ttsTrigger = (await getBotSetting('tts_trigger')) || this.config.ttsTrigger;
                const ttsEnabled = groupInfo.tts_enabled === 1;
                const ttsTriggerMode = groupInfo.tts_trigger_mode || (await getBotSetting('default_tts_trigger_mode')) || 'tag';
                let requestsTTS = false;
                if (message.skipTTS) {
                    // Active listener explicitly decided no TTS for this message
                    requestsTTS = false;
                } else if (ttsEnabled) {
                    if (ttsTriggerMode === 'always') {
                        requestsTTS = true;
                    } else {
                        requestsTTS = message.body.includes(ttsTrigger);
                    }
                }

                // Strip the TTS trigger from the message so the LLM doesn't see it
                if (requestsTTS && ttsTriggerMode === 'tag') {
                    message.body = message.body.replace(ttsTrigger, '').trim();
                }

                // Prepare System Prompt
                const promptName = groupInfo.default_prompt_name || this.defaultPromptName;
                logger.info('Queue', `Using prompt '${promptName}' for group ${groupId}`);
                let systemPrompt = this.promptManager.getPrompt(promptName);

                // Inject tagging/mention instruction into every persona's system prompt
                try {
                    const mentionInstruction = await fs.readFile(path.join(__dirname, '..', 'prompts', 'system', 'mention_instruction.txt'), 'utf-8');
                    systemPrompt += `\n${mentionInstruction}`;
                } catch (e) {
                    logger.warn('Queue', `Could not load mention_instruction.txt: ${e.message}`);
                }

                // Inject TTS-specific instructions for the LLM if applicable
                if (requestsTTS && ttsEnabled) {
                    try {
                        // Load both the TTS instruction template and the default style prompt
                        let ttsLlmInstruction = await fs.readFile(path.join(__dirname, '..', 'prompts', 'system', 'tts_system_instruction.txt'), 'utf-8');

                        // Load persona-specific TTS style prompt, or fall back to default
                        let defaultStylePrompt = this.promptManager.getTtsStylePrompt(promptName);
                        if (!defaultStylePrompt) {
                            defaultStylePrompt = this.promptManager.getTtsStylePrompt('default') || 'Speak naturally with appropriate tone.';
                        } else {
                            logger.debug('TTS', `Using persona-specific TTS style prompt for '${promptName}'`);
                        }

                        // Replace the placeholder with the actual default style prompt
                        ttsLlmInstruction = ttsLlmInstruction.replace('{DEFAULT_STYLE_PROMPT}', defaultStylePrompt);

                        systemPrompt += `\n\n${ttsLlmInstruction}`;
                    } catch (err) {
                        logger.warn('TTS', 'Could not load tts_system_instruction.txt, proceeding without it');
                    }
                }

                // Get the AI model for this group, fallback to global config
                aiModel = groupInfo.ai_model || this.config.aiModel;
                logger.info('AI', `Using model '${aiModel}' for group ${groupId}`);

                // Create a modified config with the group-specific model
                const groupConfig = { ...this.config, aiModel };

                const callAIProvider = getAiApi(this.config.aiProvider);

                // Send typing indicator before calling the LLM
                try {
                    const sockRef = client._sock;
                    if (sockRef) {
                        const jid = dbIdToJid(groupId);
                        await sockRef.sendPresenceUpdate('composing', jid);
                    }
                } catch (e) {
                    logger.warn('Queue', `Failed to send typing state: ${e.message}`);
                }

                const { response: aiResponse, tokens } = await callAIProvider(context, groupConfig, systemPrompt);
                logger.debug('AI', `Response for ${groupId}: ${aiResponse.substring(0, 100)}...`);

                // Check if the LLM decided not to answer (x$x mechanism)
                if (aiResponse.trim() === 'x$x') {
                    logger.info('AI', `LLM opted out of responding for ${groupId} (x$x)`);
                    // Still track token usage even when not sending a reply
                    if (tokens !== undefined) {
                        const extendedHistoryUsed = historyLimit > this.config.messageHistoryLimit;
                        await this.tokenUsageTracker.recordUsage(
                            senderId, groupId, tokens.prompt_tokens, tokens.completion_tokens,
                            extendedHistoryUsed, aiModel, tokens.cached_tokens || 0,
                            tokens.cost_usd || 0, tokens.provider || this.config.aiProvider || 'unknown'
                        );
                    }
                    continue;
                }

                // Parse TTS response if this is a TTS request
                let responseContent = aiResponse;
                let customStylePrompt = null;
                if (requestsTTS && ttsEnabled) {
                    const parsed = this.parseTTSResponse(aiResponse);
                    responseContent = parsed.content;
                    customStylePrompt = parsed.stylePrompt;
                    logger.debug('TTS', `Parsed response content length: ${responseContent.length}`);
                    logger.debug('TTS', `Custom style prompt: ${customStylePrompt || 'Using default'}`);
                }

                // --- Process response for mentions ---
                // Use the parsed content for mention resolution and display
                const { formattedText, mentions } = await this.resolveMentions(client, responseContent, context.groupParticipants || []);

                let ttsCost = 0;

                // --- SENDING LOGIC (Text vs Audio) ---
                if (requestsTTS && ttsEnabled) {
                    try {
                        logger.info('TTS', `Generating audio for ${groupId}...`);

                        // 1. Determine the style prompt to use
                        let stylePrompt = customStylePrompt; // Use LLM-generated style if available

                        // Fallback: try persona-specific TTS prompt, then default
                        if (!stylePrompt) {
                            stylePrompt = this.promptManager.getTtsStylePrompt(promptName);
                            if (stylePrompt) {
                                logger.debug('TTS', `Using persona-specific TTS style prompt for '${promptName}'`);
                            } else {
                                // Fall back to default persona's style prompt
                                stylePrompt = this.promptManager.getTtsStylePrompt('default');
                                if (stylePrompt) {
                                    logger.debug('TTS', 'Using default style prompt');
                                }
                            }
                        } else {
                            logger.debug('TTS', 'Using custom LLM-generated style prompt');
                        }

                        // 2. Generate Audio
                        // Resolve voice from persona > default persona > hardcoded fallback
                        const ttsVoice = this.promptManager.getTtsVoice(promptName) || 'Kore';
                        // Use the parsed response content for TTS (retry once on failure)
                        let ttsResult;
                        try {
                            ttsResult = await this.ttsService.generateAudio(responseContent, { stylePrompt, voice: ttsVoice });
                        } catch (firstAttemptError) {
                            logger.warn('TTS', `First attempt failed: ${firstAttemptError.message}. Retrying...`);
                            ttsResult = await this.ttsService.generateAudio(responseContent, { stylePrompt, voice: ttsVoice });
                        }

                        ttsCost = ttsResult.costUsd;
                        logger.info('TTS', `Generated. Cost: $${ttsCost}`);

                        // 3. Send as Voice Note
                        logger.debug('TTS', `Audio data length: ${ttsResult.audioBase64.length}`);

                        // Save to file first to ensure integrity
                        const audioFilename = `tts_${Date.now()}.ogg`;
                        const audioFilePath = path.join(this.config.audioDirectory, audioFilename);

                        await fs.writeFile(audioFilePath, Buffer.from(ttsResult.audioBase64, 'base64'));
                        logger.debug('TTS', `Saved audio to ${audioFilePath}`);

                        try {
                            logger.debug('TTS', 'Attempting to send as Voice Note...');
                            const audioBuffer = await fs.readFile(audioFilePath);
                            const sockRef = client._sock;
                            const jid = dbIdToJid(message.from);
                            await sockRef.sendMessage(jid, {
                                audio: audioBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true
                            });
                            logger.info('TTS', `Voice Note sent to ${groupId}`);
                        } catch (voiceError) {
                            logger.error('TTS', `Sending as voice note failed: ${voiceError.message}`);

                            // Fallback: Send as Document
                            logger.info('TTS', 'Attempting to send as audio file (document)...');
                            try {
                                const audioBuffer = await fs.readFile(audioFilePath);
                                const sockRef = client._sock;
                                const jid = dbIdToJid(message.from);
                                await sockRef.sendMessage(jid, {
                                    audio: audioBuffer,
                                    mimetype: 'audio/ogg; codecs=opus',
                                    ptt: false
                                });
                                logger.info('TTS', `Sent as document to ${groupId}`);
                            } catch (docError) {
                                logger.error('TTS', `Sending as document failed: ${docError.message}`);
                                throw docError;
                            }
                        }

                    } catch (ttsError) {
                        logger.error('TTS', `Generation failed for ${groupId}: ${ttsError.message}`);
                        // Fallback to text if audio fails
                        await client.sendMessage(message.from, formattedText + "\n[⚠️ Audio generation failed, falling back to text]", { mentions });
                    }
                } else {
                    // Standard Text Message
                    try {
                        await client.sendMessage(message.from, formattedText, { mentions });
                    } catch (sendError) {
                        logger.error('Queue', `Failed to send message to ${groupId} (sender: ${senderId}): ${sendError.message}`);
                    }
                }

                // --- USAGE TRACKING ---
                if (tokens !== undefined) {
                    const extendedHistoryUsed = historyLimit > this.config.messageHistoryLimit;
                    // Track LLM cost and TTS cost separately
                    const totalCost = (tokens.cost_usd || 0) + ttsCost;

                    await this.tokenUsageTracker.recordUsage(
                        senderId,
                        groupId,
                        tokens.prompt_tokens,
                        tokens.completion_tokens,
                        extendedHistoryUsed,
                        aiModel,
                        tokens.cached_tokens || 0,
                        totalCost,
                        tokens.provider || this.config.aiProvider || 'unknown',
                        ttsCost
                    );
                } else {
                    logger.warn('Queue', `Token usage undefined for user ${senderId} in ${groupId}`);
                }

                const newBotMessage = {
                    sender: this.config.botName,
                    senderId: this.config.botUserId,
                    message: responseContent, // Save only the response content (not the TTS_STYLE section)
                    timestamp: new Date().toISOString(),
                    quotedParticipant: null,
                    quotedMsg: null,
                    imageId: null,
                    whatsapp_message_id: null
                };

                await conversationStore.addMessageToConversation(groupId, newBotMessage);
                batchMessages[i].botResponse = newBotMessage;
            } catch (error) {
                logger.error('Queue', `Error processing message in ${groupId} from ${senderId}: ${error.message}`);
                try {
                    const errorReportingMode = (await getBotSetting('error_reporting_mode')) || 'send_to_chat';
                    if (errorReportingMode === 'send_to_chat') {
                        const errorMsg = error.message || '';
                        const isQuotaError = errorMsg.includes('quota') || errorMsg.includes('Quota') || errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('rate limit') || errorMsg.includes('429');
                        const userMessage = isQuotaError
                            ? `Oops! It looks like I've hit my API usage limit for now. This usually means the current plan's quota has been exceeded for the AI model configured in this group (${aiModel}). Please try again later or ask the admin to check the API plan/billing/model.`
                            : 'Sorry, I encountered an error while processing your request.';
                        await client.sendMessage(message.from, userMessage);
                    } else {
                        logger.warn('Queue', `Suppressed error message for ${groupId} (error_reporting_mode: ${errorReportingMode})`);
                    }
                } catch (sendError) {
                    logger.error('Queue', `Failed to send error message to ${groupId}: ${sendError.message}`);
                }
            } finally {
                // Add a small delay to prevent race conditions
                await sleep(1000);
            }
        }

        this.processingFlag = false;

        if (this.messageQueue.length > 0) {
            this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
        }
    }

    async prepareContext(message, chatHistory) {
        logger.debug('Queue', `Preparing context with ${chatHistory.length} messages`);

        const findQuotedImageId = (quoted_whatsapp_message_id) => {
            const quotedMessage = chatHistory.find(msg => msg.whatsapp_message_id === quoted_whatsapp_message_id);
            return quotedMessage && quotedMessage.image_id ? quotedMessage.image_id : null;
        };

        const findQuotedAudioId = (quoted_whatsapp_message_id) => {
            const quotedMessage = chatHistory.find(msg => msg.whatsapp_message_id === quoted_whatsapp_message_id);
            return quotedMessage && quotedMessage.audio_id ? quotedMessage.audio_id : null;
        };

        const redactedHistory = chatHistory.map(msg => {
            let formattedMessage = this.redactBotNumber(msg.message);
            if (msg.quoted_whatsapp_message_id) {
                let quotedMessage = '';
                let quotedImageId = findQuotedImageId(msg.quoted_whatsapp_message_id);

                if (quotedImageId) {
                    quotedMessage = `[Image: ${quotedImageId}]`;
                } else {
                    let quotedAudioId = findQuotedAudioId(msg.quoted_whatsapp_message_id);
                    if (quotedAudioId) {
                        quotedMessage = `[Audio: ${quotedAudioId}]`;
                    } else {
                        const quotedMsg = chatHistory.find(m => m.whatsapp_message_id === msg.quoted_whatsapp_message_id);
                        if (quotedMsg) {
                            quotedMessage = quotedMsg.message;
                        }
                    }
                }

                formattedMessage = `${formattedMessage} (In reply to: "${quotedMessage}")`;
            }
            return {
                ...msg,
                message: formattedMessage,
                whatsapp_message_id: msg.whatsapp_message_id
            };
        });

        let quotedImageId = null;
        let quotedAudioId = null;
        if (message.hasQuotedMsg) {
            const quotedMsgObj = await message.getQuotedMessage();
            if (quotedMsgObj) {
                quotedImageId = findQuotedImageId(quotedMsgObj.id._serialized);
                quotedAudioId = findQuotedAudioId(quotedMsgObj.id._serialized);

                // Fallback: if quoted message is an image but we have no image_id in DB,
                // try downloading the image now from the quoted message object
                if (!quotedImageId && quotedMsgObj.hasMedia && quotedMsgObj.type === 'image') {
                    logger.info('Image', `Quoted message ${quotedMsgObj.id._serialized} is an image but image_id is null in DB. Attempting download...`);
                    try {
                        const media = await quotedMsgObj.downloadMedia();
                        if (media && media.data) {
                            const imageBuffer = Buffer.from(media.data, 'base64');
                            const imageId = `img_${Date.now()}`;
                            const imagePath = path.join(this.config.imageDirectory, `${imageId}.jpg`);
                            await fs.writeFile(imagePath, imageBuffer);
                            quotedImageId = imageId;
                            logger.info('Image', `Successfully downloaded and stored as ${imageId} (${imageBuffer.length} bytes)`);
                            // Update the DB record so future lookups work
                            await conversationStore.updateImageId(quotedMsgObj.id._serialized, imageId);
                        } else {
                            logger.warn('Image', `downloadMedia() returned empty result for ${quotedMsgObj.id._serialized}`);
                        }
                    } catch (err) {
                        logger.error('Image', `Error downloading quoted image: ${err.message}`);
                    }
                }
            }
        }

        const groupInfo = await getOrCreateGroupInfo(message.from, message.groupInfo?.name || message.dmContactName || 'Unknown Group');
        let groupSummary = {};
        try {
            groupSummary = JSON.parse(groupInfo.group_summary);
        } catch (e) {
            groupSummary = {};
        }

        // Gather unique participants from chat history with their aliases
        const participantIds = new Set();
        chatHistory.forEach(msg => {
            if (msg.sender_id) {
                participantIds.add(msg.sender_id);
            }
        });

        // Get aliases for all participants
        const groupParticipants = [];
        for (const userId of participantIds) {
            const alias = await getUserAlias(userId);
            groupParticipants.push({ userId, alias });
        }

        // Load custom group context if available
        const groupCustomContext = await this.loadGroupContext(message.from);

        // Load group memories (maintained by background processor)
        const groupMemories = await this.loadGroupMemories(message.from);

        return {
            groupName: groupInfo.group_name,
            groupSummary: groupSummary,
            groupParticipants: groupParticipants,
            groupCustomContext: groupCustomContext,
            groupMemories: groupMemories,
            recentMessages: redactedHistory,
            isReplyToBot: message.quotedParticipant === this.config.botUserId,
            senderId: message.author || message.from,
            quoted_whatsapp_message_id: message.quotedMsg ? message.quotedMsg.id._serialized : null,
            quotedImageId: quotedImageId,
            quotedAudioId: quotedAudioId,
            audioEnabled: groupInfo.audio_enabled === 1,
            imageEnabled: groupInfo.image_enabled === 1,
            audioHistoryMode: groupInfo.audio_history_mode || 'tagged',
            audioHistoryCount: groupInfo.audio_history_count || 1,
            imageHistoryMode: groupInfo.image_history_mode || 'tagged',
            imageHistoryCount: groupInfo.image_history_count || 1,
            // Capture current message media
            currentImageId: message.imageId || null,
            currentAudioId: message.audioId || null
        };
    }

    redactBotNumber(message) {
        if (!message) return '';
        return message.replace(new RegExp(`@${this.config.botNumber}`, 'g'), `@${this.config.botName}`);
    }

    async reloadPrompt(promptName) {
        return await this.promptManager.reloadPrompt(promptName);
    }

    async loadGroupContext(groupId) {
        try {
            const contextPath = path.join('prompts', 'group_contexts', `${groupId}.txt`);
            const content = await fs.readFile(contextPath, 'utf-8');
            logger.debug('Queue', `Loaded group context for ${groupId}`);
            return content.trim();
        } catch (error) {
            // File doesn't exist or can't be read - this is OK, not all groups need custom context
            return null;
        }
    }

    async loadGroupMemories(groupId) {
        try {
            const memoriesPath = path.join(this.config.memoriesDirectory, `${groupId}.md`);
            const content = await fs.readFile(memoriesPath, 'utf-8');
            logger.debug('Queue', `Loaded group memories for ${groupId}`);
            return content.trim();
        } catch (error) {
            return null;
        }
    }

    async setGroupPrompt(groupId, promptName) {
        try {
            logger.info('Queue', `Setting prompt for group ${groupId} to ${promptName}`);
            const groupInfo = await getOrCreateGroupInfo(groupId);

            const updateSuccess = await updateGroupInfo(groupId, { default_prompt_name: promptName });

            if (updateSuccess) {
                logger.info('Queue', `Successfully updated prompt for group ${groupId} to ${promptName}`);
                return true;
            } else {
                logger.warn('Queue', `No changes made when updating prompt for group ${groupId}`);
                return false;
            }
        } catch (error) {
            logger.error('Queue', `Error setting group prompt for ${groupId}: ${error.message}`);
            return false;
        }
    }
}

module.exports = MessageQueueManager;
