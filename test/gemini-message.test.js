const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Replace the Google SDK with a fake client that records what would be sent
const sent = [];
class FakeGoogleGenAI {
    constructor() {
        this.chats = {
            create: () => ({
                sendMessage: async ({ message }) => {
                    sent.push(message);
                    return { text: 'ok', usageMetadata: {} };
                }
            })
        };
    }
}
require.cache[require.resolve('@google/genai')] = { exports: { GoogleGenAI: FakeGoogleGenAI } };
process.env.GEMINI_AUTH = 'api_key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const { callGeminiAPI } = require('../src/ai/gemini');
const config = require('../src/config');

const baseContext = {
    groupName: 'Test',
    senderId: 'tester',
    groupParticipants: [],
    recentMessages: [
        { sender: 'A', message: 'Sent audio id: audio_1', audio_id: 'audio_1', timestamp: '2026-01-01T00:00:00Z' },
        { sender: 'B', message: 'Sent image id: img_1', imageId: 'img_1', timestamp: '2026-01-01T00:01:00Z' },
        { sender: 'A', message: 'Sent audio id: audio_2', audio_id: 'audio_2', timestamp: '2026-01-01T00:02:00Z' }
    ]
};

describe('callGeminiAPI message text', () => {
    before(() => { sent.length = 0; });

    it('includes the "last X audio messages attached" note in history mode', async () => {
        await callGeminiAPI({ ...baseContext, audioEnabled: true, audioHistoryMode: 'history', audioHistoryCount: 2 }, config, 'system');
        const text = sent.at(-1)[0].text;
        assert.match(text, /The last 2 audio message\(s\) from the conversation history are attached: audio_1, audio_2/);
    });

    it('includes the "last X images attached" note in history mode', async () => {
        await callGeminiAPI({ ...baseContext, imageEnabled: true, imageHistoryMode: 'history', imageHistoryCount: 1 }, config, 'system');
        const text = sent.at(-1)[0].text;
        assert.match(text, /The last 1 image\(s\) from the conversation history are attached: img_1/);
    });

    it('puts the full user message in the first part', async () => {
        await callGeminiAPI({ ...baseContext }, config, 'system');
        const text = sent.at(-1)[0].text;
        assert.match(text, /Recent messages:/);
        assert.match(text, /You are now responding to/);
    });
});
