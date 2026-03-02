const { getGenAI } = require('./ai/gemini');
const { calculateCost } = require('./pricing-config');
const TokenUsageTracker = require('./token-usage-tracker');
const conversationStore = require('./conversation-store');
const { getOrCreateGroupInfo, getBotSetting } = require('./db');
const { replacePhoneNumbersWithUsernames } = require('./phone-number-replacer');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

class ActiveListener {
    constructor(config) {
        this.config = config;
        this.groupState = new Map(); // groupId -> { lastResponseTimestamp, processing }
        this.tokenUsageTracker = new TokenUsageTracker(config);
        this.handleBotInvocation = null; // set by bot.js after initialization
    }

    async initialize() {
        await this.tokenUsageTracker.initialize();
        logger.info('ActiveListener', 'Active listener initialized');
    }

    /**
     * Set the function to call when the bot should respond.
     * Signature: async (client, message, options) => void
     */
    setInvocationHandler(handler) {
        this.handleBotInvocation = handler;
    }

    /**
     * Feed a message to the active listener. Called on every group message
     * when active listening is enabled for that group.
     */
    async feedMessage(groupId, message, client, triggerInfo = {}) {
        let state = this.groupState.get(groupId);
        if (!state) {
            state = { lastResponseTimestamp: 0, processing: false };
            this.groupState.set(groupId, state);
        }

        // Prevent concurrent processing for the same group
        if (state.processing) {
            logger.debug('ActiveListener', `Already processing for ${groupId}, skipping`);
            return;
        }

        try {
            // Check group settings
            const groupInfo = await getOrCreateGroupInfo(groupId);
            if (!groupInfo.is_active || groupInfo.active_listening_enabled === 0) {
                return;
            }

            // Rate limit check
            const throttleMs = groupInfo.active_listening_throttle_ms != null
                ? groupInfo.active_listening_throttle_ms
                : this.config.activeListeningThrottleMs;

            const now = Date.now();
            if (now - state.lastResponseTimestamp < throttleMs) {
                logger.debug('ActiveListener', `Rate limited for ${groupId} (${Math.round((throttleMs - (now - state.lastResponseTimestamp)) / 1000)}s remaining)`);
                return;
            }

            state.processing = true;

            // Load recent messages for context
            const contextCount = groupInfo.active_listening_context_count != null
                ? groupInfo.active_listening_context_count
                : this.config.activeListeningContextCount;

            const messages = await conversationStore.loadConversation(groupId, contextCount);
            if (messages.length === 0) {
                return;
            }

            // Always load the master prompt (from file or global setting)
            let systemPrompt;
            try {
                systemPrompt = await fs.readFile(
                    path.join(__dirname, '..', 'prompts', 'system', 'active_listening_instruction.txt'),
                    'utf-8'
                );
            } catch (err) {
                logger.error('ActiveListener', `Could not load active_listening_instruction.txt: ${err.message}`);
                return;
            }

            // Inject per-group additional instructions into the master prompt
            const additionalInstructions = groupInfo.active_listening_prompt
                ? `\nThe following are additional instructions specific to this group. Treat them as high priority and follow them closely:\n${groupInfo.active_listening_prompt}\n`
                : '';
            systemPrompt = systemPrompt.replace(/\{additional_instructions\}/g, additionalInstructions);

            // Replace bot name placeholder
            const botName = this.config.botName || 'Bot';
            systemPrompt = systemPrompt.replace(/\{BOT_NAME\}/g, botName);

            // Format messages for the LLM
            const formattedMessages = messages.map(msg => {
                const sender = replacePhoneNumbersWithUsernames(msg.sender_id || msg.sender);
                const displayName = msg.sender || sender;
                const isBotMessage = msg.sender_id === this.config.botUserId;
                const label = isBotMessage ? `${displayName} (this is you, the bot)` : displayName;
                let line = `${label}: ${msg.message || ''}`;
                if (msg.audio_id) {
                    line += ` (Audio: ${msg.audio_id})`;
                }
                if (msg.image_id) {
                    line += ` (Image: ${msg.image_id})`;
                }
                return line;
            }).join('\n');

            let userMessage = `Group: ${groupInfo.group_name}\n\nRecent messages:\n${formattedMessages}`;

            // Resolve media settings (per-group override → global default)
            const defaultAlSendAudio = await getBotSetting('default_al_send_audio');
            const defaultAlSendImages = await getBotSetting('default_al_send_images');
            const defaultAlAudioCount = await getBotSetting('default_al_audio_count');

            const sendAudio = groupInfo.active_listening_send_audio != null
                ? groupInfo.active_listening_send_audio === 1
                : defaultAlSendAudio === '1';
            const sendImages = groupInfo.active_listening_send_images != null
                ? groupInfo.active_listening_send_images === 1
                : defaultAlSendImages === '1';
            const audioCount = groupInfo.active_listening_audio_count != null
                ? groupInfo.active_listening_audio_count
                : parseInt(defaultAlAudioCount || '3');

            const defaultAlImageCount = await getBotSetting('default_al_image_count');
            const imageCount = groupInfo.active_listening_image_count != null
                ? groupInfo.active_listening_image_count
                : parseInt(defaultAlImageCount || '3');

            // Build multipart content (text + optional media)
            const msgParts = [];

            // Attach audio files from recent history
            if (sendAudio) {
                const audioIds = messages
                    .filter(msg => msg.audio_id)
                    .map(msg => msg.audio_id)
                    .slice(-audioCount);

                if (audioIds.length > 0) {
                    userMessage += `\nNote: ${audioIds.length} audio message(s) from the conversation are attached: ${audioIds.join(', ')}. Check the "(Audio: <audio_id>)" markers above for when each was sent.`;
                    for (const audioId of audioIds) {
                        const audioData = await this._getMediaData(this.config.audioDirectory, audioId, 'audio');
                        if (audioData) msgParts.push(audioData);
                    }
                }
            }

            // Attach images from recent history
            if (sendImages) {
                const imageIds = messages
                    .filter(msg => msg.image_id)
                    .map(msg => msg.image_id)
                    .slice(-imageCount);

                if (imageIds.length > 0) {
                    userMessage += `\nNote: ${imageIds.length} image(s) from the conversation are attached: ${imageIds.join(', ')}. Check the "(Image: <image_id>)" markers above for when each was sent.`;
                    for (const imageId of imageIds) {
                        const imgPath = path.join(this.config.imageDirectory, `${imageId}.jpg`);
                        try {
                            const imgBuffer = await fs.readFile(imgPath);
                            msgParts.push({
                                inlineData: { mimeType: 'image/jpeg', data: imgBuffer.toString('base64') }
                            });
                        } catch (err) {
                            logger.warn('ActiveListener', `Image ${imageId} not found: ${err.message}`);
                        }
                    }
                }
            }

            // Text part goes first
            msgParts.unshift({ text: userMessage });

            // Determine model
            const modelOverride = await getBotSetting('active_listening_ai_model');
            const modelName = modelOverride || this.config.activeListeningAiModel;

            // Call fast LLM with retry on transient errors
            const MAX_RETRIES = 2;
            let decision;

            const genAI = getGenAI();
            if (!genAI) {
                logger.warn('ActiveListener', 'Gemini API key not configured yet, skipping active listening');
                return;
            }

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const model = genAI.getGenerativeModel({
                        model: modelName,
                        systemInstruction: systemPrompt,
                        generationConfig: {
                            maxOutputTokens: 2048,
                            temperature: 0.1
                        }
                    });
                    const result = await model.generateContent(msgParts);

                    const response = result.response;
                    const responseText = response.text().trim();

                    // Track token usage
                    const usage = response.usageMetadata || {};
                    const inputTokens = usage.promptTokenCount || 0;
                    const outputTokens = usage.candidatesTokenCount || 0;
                    const cachedTokens = usage.cachedContentTokenCount || 0;
                    const cost = calculateCost('google', modelName, inputTokens, outputTokens, cachedTokens);

                    await this.tokenUsageTracker.recordUsage(
                        'active-listener',
                        groupId,
                        inputTokens,
                        outputTokens,
                        false,
                        modelName,
                        cachedTokens,
                        cost,
                        'google'
                    );

                    // Parse JSON decision — strip markdown fences if present
                    const cleaned = responseText
                        .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
                        .replace(/\s*```[\s\S]*$/, '');
                    const jsonStr = cleaned.startsWith('{') ? cleaned : (responseText.match(/\{[\s\S]*\}/) || [''])[0];
                    if (!jsonStr) {
                        logger.warn('ActiveListener', `No JSON found in response for ${groupId}: ${responseText}`);
                        return;
                    }
                    decision = JSON.parse(jsonStr);
                    break; // Success — exit retry loop
                } catch (err) {
                    const isRetryable = err.message && (err.message.includes('503') || err.message.includes('429') || err.message.includes('overloaded'));
                    if (isRetryable && attempt < MAX_RETRIES) {
                        const delayMs = 1000 * (attempt + 1); // 1s, 2s
                        logger.warn('ActiveListener', `Retryable error for ${groupId} (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}. Retrying in ${delayMs}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }
                    // Non-retryable or exhausted retries — fall back to direct trigger if bot was mentioned/replied to
                    logger.error('ActiveListener', `LLM call failed for ${groupId} after ${attempt + 1} attempt(s): ${err.message}`);
                    if ((triggerInfo.isBotMentioned || triggerInfo.isReplyToBot) && this.handleBotInvocation) {
                        logger.info('ActiveListener', `Falling back to direct response for ${groupId} (bot was mentioned/replied to)`);
                        state.lastResponseTimestamp = Date.now();
                        await this.handleBotInvocation(client, message);
                    }
                    return;
                }
            }

            logger.debug('ActiveListener', `Decision for ${groupId}: respond=${decision.respond}, tts=${decision.tts}`);

            if (decision.respond && this.handleBotInvocation) {
                // Update rate limit timestamp
                state.lastResponseTimestamp = Date.now();

                // Handle TTS recommendation
                if (decision.tts && groupInfo.tts_enabled === 1) {
                    const ttsTrigger = (await getBotSetting('tts_trigger')) || this.config.ttsTrigger || '$audio';
                    // Inject TTS trigger so the message queue processes it as a TTS request
                    if (!message.body.includes(ttsTrigger)) {
                        message.body = (message.body || '') + ' ' + ttsTrigger;
                    }
                } else {
                    // Active listener explicitly decided no TTS — override group's trigger mode
                    message.skipTTS = true;
                }

                const ttsRequested = !!(decision.tts && groupInfo.tts_enabled === 1);
                logger.info('ActiveListener', `Triggering response for ${groupId} (tts: ${ttsRequested})`);
                await this.handleBotInvocation(client, message);
            }
        } catch (error) {
            logger.error('ActiveListener', `Error processing ${groupId}: ${error.message}`);
        } finally {
            if (state) {
                state.processing = false;
            }
        }
    }

    async _getMediaData(audioDir, audioId, type) {
        try {
            const files = await fs.readdir(audioDir);
            const audioFile = files.find(file => file.startsWith(audioId));
            if (audioFile) {
                const audioPath = path.join(audioDir, audioFile);
                const buffer = await fs.readFile(audioPath);
                const ext = path.extname(audioFile).toLowerCase();
                let mimeType = 'audio/ogg';
                if (ext === '.mp3') mimeType = 'audio/mp3';
                else if (ext === '.wav') mimeType = 'audio/wav';
                else if (ext === '.m4a') mimeType = 'audio/mp4';
                return { inlineData: { mimeType, data: buffer.toString('base64') } };
            }
        } catch (err) {
            logger.warn('ActiveListener', `${type} file ${audioId} not found: ${err.message}`);
        }
        return null;
    }

    destroy() {
        this.groupState.clear();
        logger.info('ActiveListener', 'Active listener destroyed');
    }
}

module.exports = ActiveListener;
