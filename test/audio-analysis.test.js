const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatAudioMarker } = require('../src/message-processor');
const { analyzeAudio, formatDuration, ANALYZE_AUDIO_TOOL } = require('../src/services/audio-analysis');

describe('formatAudioMarker', () => {
    it('shows only the id when nothing else is known', () => {
        assert.equal(formatAudioMarker({ audio_id: 'audio_1' }), ' (Audio: audio_1)');
    });

    it('adds the duration', () => {
        assert.equal(formatAudioMarker({ audio_id: 'audio_1', audio_duration: 7 }), ' (Audio: audio_1, 7s)');
        assert.equal(formatAudioMarker({ audio_id: 'audio_1', audio_duration: 125 }), ' (Audio: audio_1, 2m05s)');
    });

    it('adds the preview', () => {
        assert.equal(
            formatAudioMarker({ audio_id: 'audio_1', audio_duration: 95, audio_preview: 'Hey so about tomorrow…' }),
            ' (Audio: audio_1, 1m35s, starts with: "Hey so about tomorrow…")'
        );
    });
});

describe('formatDuration', () => {
    it('formats seconds and minutes', () => {
        assert.equal(formatDuration(0), '0s');
        assert.equal(formatDuration(59.6), '1m00s');
        assert.equal(formatDuration(480), '8m00s');
    });
});

describe('analyzeAudio input validation', () => {
    it('rejects ids that are not audio ids', async () => {
        const { response, costUsd } = await analyzeAudio('group@g.us', { audio_id: '../../.env', task: 'transcribe' });
        assert.match(response.error, /Invalid audio id/);
        assert.equal(costUsd, 0);
    });

    it('requires a question for task "ask"', async () => {
        const { response } = await analyzeAudio('group@g.us', { audio_id: 'audio_123', task: 'ask' });
        assert.match(response.error, /requires a question/);
    });
});

describe('ANALYZE_AUDIO_TOOL', () => {
    it('declares audio_id and task as required', () => {
        assert.equal(ANALYZE_AUDIO_TOOL.name, 'analyze_audio');
        assert.deepEqual(ANALYZE_AUDIO_TOOL.parameters.required, ['audio_id', 'task']);
        assert.deepEqual(ANALYZE_AUDIO_TOOL.parameters.properties.task.enum, ['transcribe', 'ask']);
    });
});
