const { GoogleGenerativeAI } = require('@google/generative-ai');
const { calculateCost } = require('./pricing-config');
const TokenUsageTracker = require('./token-usage-tracker');
const conversationStore = require('./conversation-store');
const { getOrCreateGroupInfo, getBotSetting } = require('./db');
const logger = require('./logger');

require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

class BackgroundProcessor {
    constructor(config) {
        this.config = config;
        this.groupState = new Map(); // groupId -> { timer, messageCount, lastProcessedTimestamp }
        this.handlers = new Map();   // name -> handler function
        this.tokenUsageTracker = new TokenUsageTracker(config);
    }

    async initialize() {
        await this.tokenUsageTracker.initialize();
        logger.info('Background', 'Background processor initialized');
    }

    /**
     * Register a handler that runs when background processing triggers.
     * Handler signature: async (groupId, messages, config) => void
     */
    registerHandler(name, handler) {
        this.handlers.set(name, handler);
        logger.info('Background', `Registered handler: ${name}`);
    }

    /**
     * Feed a message into the background processor. Called on every group message.
     * Manages per-group debounce (time + count).
     */
    async feedMessage(groupId) {
        let state = this.groupState.get(groupId);
        if (!state) {
            state = {
                timer: null,
                messageCount: 0,
                lastProcessedTimestamp: null
            };
            this.groupState.set(groupId, state);
        }

        state.messageCount++;

        // Clear existing timer and reset
        if (state.timer) {
            clearTimeout(state.timer);
        }

        // Use per-group overrides if set, otherwise fall back to global config
        let debounceMs = this.config.backgroundDebounceMs;
        let threshold = this.config.backgroundMessageThreshold;
        try {
            const groupInfo = await getOrCreateGroupInfo(groupId);
            if (groupInfo.background_debounce_ms != null) {
                debounceMs = groupInfo.background_debounce_ms;
            }
            if (groupInfo.background_message_threshold != null) {
                threshold = groupInfo.background_message_threshold;
            }
        } catch (err) {
            logger.warn('Background', `Could not load group overrides for ${groupId}: ${err.message}`);
        }

        // Check message count threshold
        if (state.messageCount >= threshold) {
            this._triggerProcessing(groupId);
            return;
        }

        // Set inactivity timer
        state.timer = setTimeout(() => {
            this._triggerProcessing(groupId);
        }, debounceMs);
    }

    async _triggerProcessing(groupId) {
        const state = this.groupState.get(groupId);
        if (!state || state.messageCount === 0) return;

        // Reset state
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        const messageCount = state.messageCount;
        state.messageCount = 0;

        try {
            // Check global background processing switch
            const globalEnabled = await getBotSetting('background_processing_global');
            if (globalEnabled === '0') {
                logger.debug('Background', `Background processing globally disabled, skipping ${groupId}`);
                return;
            }

            // Check if group is active and has background processing enabled
            const groupInfo = await getOrCreateGroupInfo(groupId);
            if (!groupInfo.is_active) {
                logger.debug('Background', `Skipping inactive group ${groupId}`);
                return;
            }
            if (groupInfo.background_processing_enabled === 0) {
                logger.debug('Background', `Background processing disabled for ${groupId}`);
                return;
            }

            // Load messages since last processed
            const historyLimit = Math.max(messageCount + 5, 30); // some buffer
            const allMessages = await conversationStore.loadConversation(groupId, historyLimit);

            // Filter to only messages since last processed
            let messages = allMessages;
            if (state.lastProcessedTimestamp) {
                messages = allMessages.filter(m => m.timestamp > state.lastProcessedTimestamp);
            }

            if (messages.length === 0) {
                logger.debug('Background', `No new messages to process for ${groupId}`);
                return;
            }

            logger.info('Background', `Processing ${messages.length} messages for group ${groupId}`);

            // Update last processed timestamp
            state.lastProcessedTimestamp = messages[messages.length - 1].timestamp;

            // Determine model
            const modelOverride = await getBotSetting('background_ai_model');
            const modelName = modelOverride || this.config.backgroundAiModel;

            // Run all registered handlers
            for (const [name, handler] of this.handlers) {
                try {
                    await handler(groupId, messages, {
                        config: this.config,
                        groupInfo,
                        modelName,
                        genAI,
                        calculateCost,
                        tokenUsageTracker: this.tokenUsageTracker
                    });
                } catch (err) {
                    logger.error('Background', `Handler '${name}' failed for ${groupId}: ${err.message}`);
                }
            }
        } catch (error) {
            logger.error('Background', `Error processing group ${groupId}: ${error.message}`);
        }
    }

    /**
     * Clean up timers on shutdown.
     */
    destroy() {
        for (const [, state] of this.groupState) {
            if (state.timer) {
                clearTimeout(state.timer);
            }
        }
        this.groupState.clear();
        logger.info('Background', 'Background processor destroyed');
    }
}

module.exports = BackgroundProcessor;
