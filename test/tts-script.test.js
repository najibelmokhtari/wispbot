const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseVoiceScript, stripVocalTags } = require('../src/services/tts-script');

describe('parseVoiceScript', () => {
    it('parses styled segments from a voice script', () => {
        const { segments } = parseVoiceScript([
            '[VOICE_SCRIPT]',
            '[style: calm] Okay, listen. <short pause>',
            '[style: whispered, conspiratorial] I have a secret.',
            '[style: singing the melody, cheerful] Happy birthday to you!'
        ].join('\n'));
        assert.deepEqual(segments, [
            { style: 'calm', text: 'Okay, listen. <short pause>' },
            { style: 'whispered, conspiratorial', text: 'I have a secret.' },
            { style: 'singing the melody, cheerful', text: 'Happy birthday to you!' }
        ]);
    });

    it('ignores anything before the [VOICE_SCRIPT] marker', () => {
        const { segments } = parseVoiceScript('Sure!\n[VOICE_SCRIPT]\n[style: warm] Hi there.');
        assert.deepEqual(segments, [{ style: 'warm', text: 'Hi there.' }]);
    });

    it('appends unprefixed lines to the current segment', () => {
        const { segments } = parseVoiceScript('[VOICE_SCRIPT]\n[style: warm] Line one.\nLine two.');
        assert.deepEqual(segments, [{ style: 'warm', text: 'Line one.\nLine two.' }]);
    });

    it('keeps text before the first style line as an unstyled segment', () => {
        const { segments } = parseVoiceScript('[VOICE_SCRIPT]\nHello.\n[style: shouting] HEY!');
        assert.deepEqual(segments, [{ style: null, text: 'Hello.' }, { style: 'shouting', text: 'HEY!' }]);
    });

    it('merges consecutive segments with the same style and drops empty ones', () => {
        const { segments } = parseVoiceScript('[VOICE_SCRIPT]\n[style: warm] One.\n[style: warm] Two.\n[style: sad]\n');
        assert.deepEqual(segments, [{ style: 'warm', text: 'One.\nTwo.' }]);
    });

    it('treats an empty style as unstyled', () => {
        const { segments } = parseVoiceScript('[VOICE_SCRIPT]\n[style: ] Plain.');
        assert.deepEqual(segments, [{ style: null, text: 'Plain.' }]);
    });

    it('supports the legacy [RESPONSE]/[TTS_STYLE] format', () => {
        const { segments } = parseVoiceScript('[RESPONSE]\nHello there.\n[TTS_STYLE]\nCheerful tone.');
        assert.deepEqual(segments, [{ style: 'Cheerful tone.', text: 'Hello there.' }]);
    });

    it('falls back to the whole reply as one unstyled segment', () => {
        const { segments } = parseVoiceScript('Just some text.');
        assert.deepEqual(segments, [{ style: null, text: 'Just some text.' }]);
    });

    it('returns plain text without style markers or vocal tags', () => {
        const { plainText } = parseVoiceScript('[VOICE_SCRIPT]\n[style: warm] <laugh> Okay, listen. <short pause>\n[style: whispered] It was me <sigh> obviously.');
        assert.equal(plainText, 'Okay, listen.\nIt was me obviously.');
    });

    it('keeps Arabic text and strips English tags inside it', () => {
        const { plainText } = parseVoiceScript('[VOICE_SCRIPT]\n[style: playful] سلام عليكم <laugh> كيداير؟');
        assert.equal(plainText, 'سلام عليكم كيداير؟');
    });
});

describe('stripVocalTags', () => {
    it('only removes known vocal tags', () => {
        assert.equal(stripVocalTags('I <3 you <giggle> and <b>bold</b>'), 'I <3 you and <b>bold</b>');
    });
});
