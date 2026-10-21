/**
 * Voice script parsing for Gemini 3.8 Flash TTS.
 *
 * The LLM writes audio replies as a script of segments:
 *
 *   [VOICE_SCRIPT]
 *   [style: calm, conversational] Okay, listen. <short pause>
 *   [style: whispered, conspiratorial] I have a secret to tell you.
 *   [style: singing the melody, cheerful] Happy birthday to you!
 *
 * Each `[style: ...]` line starts a new segment whose style is sent as
 * `speechMetadata.style` on its own part; lines without a prefix continue the
 * current segment. Angle-bracket vocal tags like <laugh> stay inline in the
 * text — the model performs them instead of reading them out.
 */

// Vocal tags documented for Gemini 3.8 Flash TTS
const VOCAL_TAGS = [
    'argh', 'breath', 'heavy breath', 'exhales', 'cackle', 'cheer', 'chuckle', 'chuckles', 'cough',
    'cry', 'gasp', 'giggle', 'groan', 'growl', 'grunt', 'grr', 'hiss', 'laugh', 'laughter', 'moan',
    'pant', 'pff', 'phew', 'scream', 'shout', 'shriek', 'sigh', 'sighs', 'sneeze', 'snicker', 'snort',
    'sob', 'throat-clearing', 'tsk', 'whimper', 'whispers', 'whispering', 'yawn', 'short pause', 'long pause'
];

const TAG_PATTERN = new RegExp(`\\s*<(?:${VOCAL_TAGS.map(t => t.replace('-', '\\-')).join('|')})>\\s*`, 'gi');
const STYLE_LINE = /^\s*\[style:\s*([^\]]*)\]\s*(.*)$/i;

/**
 * Removes vocal tags so the script reads as plain text (for history and text fallback).
 * @param {string} text
 * @returns {string}
 */
function stripVocalTags(text) {
    return text.replace(TAG_PATTERN, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?،؟])/g, '$1').trim();
}

/**
 * Parses an LLM audio reply into TTS segments.
 * Accepts the [VOICE_SCRIPT] format, the legacy [RESPONSE]/[TTS_STYLE] format,
 * or plain text (one unstyled segment).
 * @param {string} response - Raw LLM output
 * @returns {{ segments: {text: string, style: string|null}[], plainText: string }}
 */
function parseVoiceScript(response) {
    const raw = (response || '').trim();
    let segments = [];

    const scriptMatch = raw.match(/\[VOICE_SCRIPT\]([\s\S]*)$/i);
    const legacyResponse = raw.match(/\[RESPONSE\]([\s\S]*?)(?:\[TTS_STYLE\]|$)/);

    if (scriptMatch) {
        let current = null;
        for (const line of scriptMatch[1].split(/\r?\n/)) {
            const styled = line.match(STYLE_LINE);
            if (styled) {
                current = { style: styled[1].trim() || null, text: styled[2].trim() };
                segments.push(current);
            } else if (line.trim()) {
                if (!current) {
                    current = { style: null, text: '' };
                    segments.push(current);
                }
                current.text = current.text ? `${current.text}\n${line.trim()}` : line.trim();
            }
        }
    } else if (legacyResponse) {
        const legacyStyle = raw.match(/\[TTS_STYLE\]([\s\S]*?)$/);
        segments.push({ style: legacyStyle ? legacyStyle[1].trim() || null : null, text: legacyResponse[1].trim() });
    } else {
        segments.push({ style: null, text: raw });
    }

    // Drop empty segments and merge neighbours that share a style
    segments = segments.filter(s => s.text).reduce((acc, seg) => {
        const prev = acc[acc.length - 1];
        if (prev && prev.style === seg.style) prev.text += `\n${seg.text}`;
        else acc.push({ ...seg });
        return acc;
    }, []);

    const plainText = segments.map(s => stripVocalTags(s.text)).filter(Boolean).join('\n');
    return { segments, plainText };
}

module.exports = { parseVoiceScript, stripVocalTags, VOCAL_TAGS };
