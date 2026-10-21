// Pricing configuration in USD per 1,000,000 tokens
// Based on Google Vertex AI / Gemini API pricing
const PRICING_RATES = {
    'gemini-2.5-flash': {
        input: 0.075,      // $0.075 / 1M input tokens
        output: 0.30,      // $0.30 / 1M output tokens
        cache_read: 0.02   // ~$0.02 / 1M cached input tokens (approx 75% discount)
    },
    'gemini-2.5-pro': {
        input: 1.25,       // $1.25 / 1M input tokens
        output: 5.00,      // $5.00 / 1M output tokens
        cache_read: 0.3125 // ~$0.31 / 1M cached input tokens
    },
    'gemini-3-flash-preview': {
        input: 0.50,       // $0.50 / 1M input tokens
        output: 3.00,      // $3.00 / 1M output tokens
        cache_read: 0.05   // $0.05 / 1M cached input tokens
    },
    'gemini-3.1-pro-preview': {
        input: 2.00,
        output: 12.00,
        cache_read: 0.2
    },
    'gemini-3.5-flash-lite': {
        input: 0.30,       // Third-party listed rate; no separate audio input rate published
        output: 2.50,
        cache_read: 0.03
    },
    'gemini-4-argon': {
        input: 2.00,       // Introductory rate through Nov 30, 2026 ($4.00 after)
        output: 10.00,     // Introductory rate through Nov 30, 2026 ($20.00 after)
        cache_read: 0.2    // Estimate (10% of input), not yet confirmed
    },
    // Default fallback (using Flash rates as a safe default)
    'default': {
        input: 0.075,
        output: 0.30,
        cache_read: 0.02
    }
};

// TTS Pricing Configuration
const TTS_PRICING = {
    'gemini-2.5-flash-tts':         { input_per_1m: 0.50, output_per_1m: 10.00 },
    'gemini-2.5-flash-preview-tts': { input_per_1m: 0.50, output_per_1m: 10.00 },
    'gemini-2.5-pro-tts':           { input_per_1m: 1.00, output_per_1m: 20.00 },
    'gemini-2.5-pro-preview-tts':   { input_per_1m: 1.00, output_per_1m: 20.00 },
    'gemini-3.8-flash-tts':         { input_per_1m: 0.50, output_per_1m: 9.00 },
    'studio': 160.00,
    'neural2': 16.00,
    'wavenet': 16.00,
    'standard': 4.00
};

/**
 * Calculates the estimated cost of an AI API call.
 * @param {string} provider - The AI provider (e.g., 'google')
 * @param {string} model - The model name (e.g., 'gemini-2.5-flash')
 * @param {number} inputTokens - Total input tokens (including cached)
 * @param {number} outputTokens - Total output tokens
 * @param {number} cachedTokens - Number of tokens that were cached (subset of inputTokens)
 * @returns {number} Estimated cost in USD
 */
function calculateCost(provider, model, inputTokens, outputTokens, cachedTokens = 0) {
    if (provider !== 'google') {
        // Placeholder for other providers
        return 0;
    }

    // Normalize model name to lowercase to match keys
    const modelKey = model ? model.toLowerCase() : 'default';
    const rates = PRICING_RATES[modelKey] || PRICING_RATES['default'];

    // For Gemini, 'inputTokens' usually implies the total prompt size.
    // We subtract cached tokens to find the "fresh" input tokens.
    const freshInputTokens = Math.max(0, inputTokens - cachedTokens);

    const inputCost = (freshInputTokens / 1000000) * rates.input;
    const cacheCost = (cachedTokens / 1000000) * rates.cache_read;
    const outputCost = (outputTokens / 1000000) * rates.output;

    return inputCost + cacheCost + outputCost;
}

/**
 * Calculates estimated TTS cost.
 * @param {string} modelName
 * @param {number} charCount
 * @returns {number} Cost in USD
 */
function calculateTTSCost(modelName, charCount) {
    const modelKey = modelName ? modelName.toLowerCase() : 'standard';

    // 1. Token-Based Pricing (Flash/Pro TTS)
    if (TTS_PRICING[modelKey] && TTS_PRICING[modelKey].input_per_1m) {
        const rates = TTS_PRICING[modelKey];
        // Heuristic: 1 token ≈ 4 chars
        const estInputTokens = charCount / 4.0;
        const inputCost = (estInputTokens / 1000000) * rates.input_per_1m;

        // Heuristic: Audio Duration (15 chars/sec -> 25 tokens/sec)
        const estDurationSeconds = charCount / 15.0;
        const estOutputTokens = estDurationSeconds * 25.0;
        const outputCost = (estOutputTokens / 1000000) * rates.output_per_1m;

        return inputCost + outputCost;
    }

    // 2. Character-Based Pricing (Standard/WaveNet/Neural2)
    let pricePer1m = TTS_PRICING['standard'];
    if (modelKey.includes('studio')) pricePer1m = TTS_PRICING['studio'];
    else if (modelKey.includes('neural2')) pricePer1m = TTS_PRICING['neural2'];
    else if (modelKey.includes('wavenet')) pricePer1m = TTS_PRICING['wavenet'];

    return (charCount / 1000000) * pricePer1m;
}

// Available Gemini models registry
const AVAILABLE_MODELS = {
    'gemini-2.5-flash': {
        displayName: 'Gemini 2.5 Flash',
        description: 'Fast and efficient model'
    },
    'gemini-2.5-pro': {
        displayName: 'Gemini 2.5 Pro',
        description: 'Most capable model'
    },
    'gemini-3-flash-preview': {
        displayName: 'Gemini 3 Flash Preview',
        description: 'Fast next-gen model'
    },
    'gemini-3.1-pro-preview': {
        displayName: 'Gemini 3.1 Pro Preview',
        description: 'Most capable next-gen model'
    },
    'gemini-4-argon': {
        displayName: 'Gemini 4 Argon',
        description: 'Latest reasoning model'
    },
};

/**
 * Validates if a model name is supported
 * @param {string} modelName - The model name to validate
 * @returns {boolean} True if the model is available
 */
function isValidModel(modelName) {
    return modelName && AVAILABLE_MODELS.hasOwnProperty(modelName.toLowerCase());
}

/**
 * Gets the list of available model names
 * @returns {string[]} Array of model names
 */
function getAvailableModels() {
    return Object.keys(AVAILABLE_MODELS);
}

module.exports = {
    calculateCost,
    calculateTTSCost,
    PRICING_RATES,
    TTS_PRICING,
    AVAILABLE_MODELS,
    isValidModel,
    getAvailableModels
};