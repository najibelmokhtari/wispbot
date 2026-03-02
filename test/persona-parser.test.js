const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePersonaFile, serializePersona } = require('../src/persona-parser');

const SAMPLE_PERSONA = `[meta]
description = A dry humor assistant
author = testauthor
version = 1.0
tags = english, humor, deadpan
created = 2026-01-01
updated = 2026-01-01

[voice]
Zubenelgenubi

[system_prompt]
You are a deadpan AI assistant.
You deliver help like a bored librarian.

[tts_style]
Speak in a flat, monotone voice.
`;

describe('parsePersonaFile', () => {
    it('parses all sections correctly', () => {
        const result = parsePersonaFile(SAMPLE_PERSONA);

        assert.equal(result.meta.description, 'A dry humor assistant');
        assert.equal(result.meta.author, 'testauthor');
        assert.equal(result.meta.version, '1.0');
        assert.deepEqual(result.meta.tags, ['english', 'humor', 'deadpan']);
        assert.equal(result.voice, 'Zubenelgenubi');
        assert.ok(result.systemPrompt.includes('deadpan AI assistant'));
        assert.ok(result.ttsStyle.includes('flat, monotone'));
    });

    it('handles missing sections gracefully', () => {
        const result = parsePersonaFile('[meta]\nauthor = someone\n');
        assert.equal(result.meta.author, 'someone');
        assert.equal(result.voice, '');
        assert.equal(result.systemPrompt, '');
        assert.equal(result.ttsStyle, '');
    });

    it('handles empty input', () => {
        const result = parsePersonaFile('');
        assert.deepEqual(result.meta, {});
        assert.equal(result.voice, '');
        assert.equal(result.systemPrompt, '');
        assert.equal(result.ttsStyle, '');
    });
});

describe('serializePersona', () => {
    it('round-trips a parsed persona', () => {
        const parsed = parsePersonaFile(SAMPLE_PERSONA);
        const serialized = serializePersona(parsed);
        const reparsed = parsePersonaFile(serialized);

        assert.deepEqual(reparsed.meta, parsed.meta);
        assert.equal(reparsed.voice, parsed.voice);
        assert.equal(reparsed.systemPrompt, parsed.systemPrompt);
        assert.equal(reparsed.ttsStyle, parsed.ttsStyle);
    });

    it('omits empty sections', () => {
        const serialized = serializePersona({
            meta: {},
            voice: '',
            systemPrompt: 'Just a prompt.',
            ttsStyle: ''
        });
        assert.ok(!serialized.includes('[meta]'));
        assert.ok(!serialized.includes('[voice]'));
        assert.ok(!serialized.includes('[tts_style]'));
        assert.ok(serialized.includes('[system_prompt]'));
    });
});
