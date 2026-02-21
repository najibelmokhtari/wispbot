/**
 * Parser for .persona files.
 *
 * Format:
 *   [voice]
 *   Zubenelgenubi
 *
 *   [system_prompt]
 *   You are casawi, a Moroccan street-smart character...
 *
 *   [tts_style]
 *   Speak in Moroccan Darija...
 *
 * All sections are optional. Content between section headers is trimmed.
 */

const SECTION_REGEX = /^\[(\w+)\]\s*$/;
const KNOWN_SECTIONS = new Set(['voice', 'system_prompt', 'tts_style']);

function parsePersonaFile(content) {
    const result = { voice: '', systemPrompt: '', ttsStyle: '' };
    const lines = content.split('\n');
    let currentSection = null;
    const sectionLines = {};

    for (const line of lines) {
        const match = line.match(SECTION_REGEX);
        if (match && KNOWN_SECTIONS.has(match[1])) {
            currentSection = match[1];
            sectionLines[currentSection] = [];
        } else if (currentSection) {
            sectionLines[currentSection].push(line);
        }
    }

    if (sectionLines.voice) result.voice = sectionLines.voice.join('\n').trim();
    if (sectionLines.system_prompt) result.systemPrompt = sectionLines.system_prompt.join('\n').trim();
    if (sectionLines.tts_style) result.ttsStyle = sectionLines.tts_style.join('\n').trim();

    return result;
}

function serializePersona({ voice, systemPrompt, ttsStyle }) {
    const parts = [];

    if (voice) {
        parts.push(`[voice]\n${voice.trim()}`);
    }

    if (systemPrompt) {
        parts.push(`[system_prompt]\n${systemPrompt.trim()}`);
    }

    if (ttsStyle) {
        parts.push(`[tts_style]\n${ttsStyle.trim()}`);
    }

    return parts.join('\n\n') + '\n';
}

module.exports = { parsePersonaFile, serializePersona };
