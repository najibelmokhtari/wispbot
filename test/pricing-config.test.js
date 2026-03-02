const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    calculateCost,
    calculateTTSCost,
    isValidModel,
    getAvailableModels
} = require('../src/pricing-config');

describe('calculateCost', () => {
    it('returns 0 for non-google providers', () => {
        assert.equal(calculateCost('openai', 'gpt-4', 1000000, 500000), 0);
    });

    it('calculates cost for gemini-2.5-flash with no cache', () => {
        // 1M input * 0.075 + 1M output * 0.30 = 0.075 + 0.30 = 0.375
        const cost = calculateCost('google', 'gemini-2.5-flash', 1000000, 1000000, 0);
        assert.equal(cost, 0.375);
    });

    it('calculates cost with cached tokens', () => {
        // 500K fresh input * 0.075/1M + 500K cached * 0.02/1M + 1M output * 0.30/1M
        const cost = calculateCost('google', 'gemini-2.5-flash', 1000000, 1000000, 500000);
        const expected = (500000 / 1e6) * 0.075 + (500000 / 1e6) * 0.02 + (1000000 / 1e6) * 0.30;
        assert.equal(cost, expected);
    });

    it('falls back to default rates for unknown models', () => {
        const cost = calculateCost('google', 'unknown-model', 1000000, 1000000);
        // Default rates = flash rates
        assert.equal(cost, 0.375);
    });

    it('handles null model gracefully', () => {
        const cost = calculateCost('google', null, 1000000, 0);
        assert.equal(cost, (1000000 / 1e6) * 0.075);
    });
});

describe('calculateTTSCost', () => {
    it('calculates token-based cost for flash TTS', () => {
        const cost = calculateTTSCost('gemini-2.5-flash-preview-tts', 1000);
        assert.ok(cost > 0);
    });

    it('calculates character-based cost for standard TTS', () => {
        const cost = calculateTTSCost('standard', 1000000);
        assert.equal(cost, 4.00);
    });

    it('uses standard pricing as fallback for unknown models', () => {
        const cost = calculateTTSCost('unknown-tts', 1000000);
        assert.equal(cost, 4.00);
    });
});

describe('isValidModel', () => {
    it('returns true for known models', () => {
        assert.equal(isValidModel('gemini-2.5-flash'), true);
        assert.equal(isValidModel('gemini-2.5-pro'), true);
    });

    it('returns false for unknown models', () => {
        assert.equal(isValidModel('gpt-4'), false);
    });

    it('returns falsy for null/undefined', () => {
        assert.ok(!isValidModel(null));
        assert.ok(!isValidModel(undefined));
    });
});

describe('getAvailableModels', () => {
    it('returns a non-empty array of strings', () => {
        const models = getAvailableModels();
        assert.ok(Array.isArray(models));
        assert.ok(models.length > 0);
        models.forEach(m => assert.equal(typeof m, 'string'));
    });

    it('includes known models', () => {
        const models = getAvailableModels();
        assert.ok(models.includes('gemini-2.5-flash'));
        assert.ok(models.includes('gemini-2.5-pro'));
    });
});
