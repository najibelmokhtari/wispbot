/**
 * Parser for .persona files.
 *
 * Format:
 *   [meta]
 *   description = A helpful assistant persona
 *   author = najibelmokhtari
 *   version = 1.0
 *   tags = english, helpful, professional
 *   created = 2026-02-22
 *   updated = 2026-02-22
 *
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
 * The [meta] section uses key = value pairs (one per line).
 * All other sections use free-form text content.
 */

const SECTION_REGEX = /^\[(\w+)\]\s*$/;
const KNOWN_SECTIONS = new Set(['meta', 'voice', 'system_prompt', 'tts_style']);
const META_LINE_REGEX = /^(\w+)\s*=\s*(.*)$/;

/**
 * Parse key = value pairs from [meta] section lines.
 */
function parseMetaSection(lines) {
    const meta = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(META_LINE_REGEX);
        if (match) {
            const key = match[1];
            let value = match[2].trim();
            // Parse tags as comma-separated array
            if (key === 'tags') {
                value = value ? value.split(',').map(t => t.trim()).filter(Boolean) : [];
            }
            meta[key] = value;
        }
    }
    return meta;
}

/**
 * Serialize a meta object back to key = value lines.
 */
function serializeMetaSection(meta) {
    const lines = [];
    // Write fields in a stable order
    const orderedKeys = ['description', 'author', 'version', 'tags', 'created', 'updated'];
    const written = new Set();

    for (const key of orderedKeys) {
        if (meta[key] !== undefined && meta[key] !== '' && !(Array.isArray(meta[key]) && meta[key].length === 0)) {
            const value = Array.isArray(meta[key]) ? meta[key].join(', ') : meta[key];
            lines.push(`${key} = ${value}`);
            written.add(key);
        }
    }
    // Write any extra keys not in the ordered list
    for (const [key, val] of Object.entries(meta)) {
        if (!written.has(key) && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
            const value = Array.isArray(val) ? val.join(', ') : val;
            lines.push(`${key} = ${value}`);
        }
    }
    return lines.join('\n');
}

function parsePersonaFile(content) {
    const result = { meta: {}, voice: '', systemPrompt: '', ttsStyle: '' };
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

    if (sectionLines.meta) result.meta = parseMetaSection(sectionLines.meta);
    if (sectionLines.voice) result.voice = sectionLines.voice.join('\n').trim();
    if (sectionLines.system_prompt) result.systemPrompt = sectionLines.system_prompt.join('\n').trim();
    if (sectionLines.tts_style) result.ttsStyle = sectionLines.tts_style.join('\n').trim();

    return result;
}

function serializePersona({ meta, voice, systemPrompt, ttsStyle }) {
    const parts = [];

    if (meta && Object.keys(meta).length > 0) {
        const metaContent = serializeMetaSection(meta);
        if (metaContent) {
            parts.push(`[meta]\n${metaContent}`);
        }
    }

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
