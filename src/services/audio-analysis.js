/**
 * Voice note analysis with a cheap audio model (Flash-Lite):
 *  - previews: a short transcript of the first seconds of each incoming voice note
 *    (per-group opt-in), stored with the message so the main LLM sees it in history
 *  - analyze_audio: a tool the main LLM can call to transcribe a whole voice note
 *    or ask a specific question about it
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const conversationStore = require('../conversation-store');
const TokenUsageTracker = require('../token-usage-tracker');
const { calculateCost } = require('../pricing-config');

const execFileAsync = promisify(execFile);

const AUDIO_ID_PATTERN = /^audio_\d+$/;

const MIME_TYPES = { '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mp3', '.mpeg': 'audio/mpeg', '.mpga': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac' };

const PREVIEW_PROMPT = (seconds) => `Transcribe this audio verbatim, in the language and script actually spoken (e.g. Moroccan Darija in Arabic script, French in Latin script).
It is only the first ${seconds} seconds of a longer voice note, so it may stop mid-word or mid-sentence: transcribe only the words that are clearly spoken and never guess or complete a cut-off ending.
If there is no speech, describe the sound in brackets, e.g. [music] or [silence].
Output only the transcript, with no introduction or quotes.`;

const TRANSCRIBE_PROMPT = `Transcribe this voice note completely and verbatim, from the first word to the last. Do not summarize, shorten or skip anything, including repetitions and hesitations.
Write each word in the language and script actually spoken (e.g. Moroccan Darija in Arabic script, French in Latin script). Keep code-switching as spoken.
If there are several speakers, start each turn on a new line with "Speaker 1:", "Speaker 2:", etc.
Mark unclear passages as [inaudible] instead of guessing. Describe notable non-speech sounds in brackets, e.g. [laughs].
Output only the transcript.`;

const QUESTION_PROMPT = (question) => `Listen to this voice note and answer the request below. Base your answer only on what is in the audio; if the audio doesn't contain the answer, say so.
Quote the speaker's exact words where useful, in their original language.

Request: ${question}`;

// Tool declaration for the main LLM (Gemini function calling)
const ANALYZE_AUDIO_TOOL = {
    name: 'analyze_audio',
    description: 'Listen to a voice note from this chat, identified by its audio id (e.g. audio_1772209104664, shown as "(Audio: <id>)" in the message history). '
        + 'Use it when you need to know what a voice note says and the short preview in the history (if any) is not enough. '
        + 'task "transcribe" returns the full transcript; task "ask" answers a specific question about the audio (content, tone, emotion, background sounds, who is speaking...). '
        + `Voice notes longer than ${Math.round(config.audioAnalysisMaxSeconds / 60)} minutes are only analyzed up to that point.`,
    parameters: {
        type: 'OBJECT',
        properties: {
            audio_id: { type: 'STRING', description: 'The audio id from the message history, e.g. audio_1772209104664' },
            task: { type: 'STRING', enum: ['transcribe', 'ask'], description: '"transcribe" for a full transcript, "ask" to ask a specific question' },
            question: { type: 'STRING', description: 'Required when task is "ask": what you want to know about the audio' }
        },
        required: ['audio_id', 'task']
    }
};

let usageTracker = null;
function getUsageTracker() {
    if (!usageTracker) usageTracker = new TokenUsageTracker(config);
    return usageTracker;
}

/**
 * Formats a duration in seconds as "45s" or "2m05s".
 */
function formatDuration(seconds) {
    const s = Math.round(seconds || 0);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

async function findAudioFile(audioId) {
    if (!AUDIO_ID_PATTERN.test(audioId)) return null;
    const files = await fs.readdir(config.audioDirectory);
    const file = files.find(f => f.startsWith(`${audioId}.`));
    return file ? path.join(config.audioDirectory, file) : null;
}

async function probeDuration(filePath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
        const seconds = parseFloat(stdout.trim());
        return Number.isFinite(seconds) ? seconds : 0;
    } catch (err) {
        logger.warn('Audio', `ffprobe failed for ${path.basename(filePath)}: ${err.message}`);
        return 0;
    }
}

/**
 * Returns the audio (trimmed to maxSeconds if longer) as { data, mimeType }.
 */
async function loadAudio(filePath, duration, maxSeconds) {
    if (duration && duration <= maxSeconds) {
        const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'audio/ogg';
        return { data: await fs.readFile(filePath), mimeType };
    }
    const outPath = path.join(os.tmpdir(), `wispbot_trim_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);
    try {
        await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-t', String(maxSeconds), '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', outPath]);
        return { data: await fs.readFile(outPath), mimeType: 'audio/ogg' };
    } finally {
        await fs.unlink(outPath).catch(() => {});
    }
}

async function callAudioModel(audio, prompt, model, thinkingLevel = null) {
    // Required lazily: ai/gemini.js requires this module for the tool declaration
    const genAI = require('../ai/gemini').getGenAI();
    if (!genAI) throw new Error('Gemini credentials not configured');
    const response = await genAI.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: audio.mimeType, data: audio.data.toString('base64') } }, { text: prompt }] }],
        config: thinkingLevel ? { thinkingConfig: { thinkingLevel } } : undefined
    });
    const usage = response.usageMetadata || {};
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
    return {
        text: (response.text || '').trim(),
        model,
        inputTokens,
        outputTokens,
        costUsd: calculateCost('google', model, inputTokens, outputTokens, 0)
    };
}

/**
 * Transcribes the first `seconds` of a voice note and stores it as the message's preview.
 * Runs in the background; failures are logged, never thrown.
 */
async function transcribePreview({ groupId, audioId, duration, seconds }) {
    try {
        const filePath = await findAudioFile(audioId);
        if (!filePath) return;
        const totalDuration = duration || await probeDuration(filePath);
        const previewSeconds = seconds || config.audioPreviewSeconds;

        const audio = await loadAudio(filePath, totalDuration, previewSeconds);
        const result = await callAudioModel(audio, PREVIEW_PROMPT(previewSeconds), config.audioPreviewModel);
        const isPartial = !totalDuration || totalDuration > previewSeconds + 0.5;
        const preview = result.text ? `${result.text.replace(/[.…\s]+$/, '')}${isPartial ? '…' : ''}` : '';

        await conversationStore.setAudioPreview(audioId, preview, totalDuration);
        await getUsageTracker().recordUsage('audio-preview', groupId, result.inputTokens, result.outputTokens, false, result.model, 0, result.costUsd, 'google');
        logger.info('Audio', `Preview for ${audioId} (${formatDuration(totalDuration)}): ${preview.slice(0, 80)}`);
    } catch (err) {
        logger.error('Audio', `Preview transcription failed for ${audioId}: ${err.message}`);
    }
}

/**
 * Executes the analyze_audio tool for the main LLM.
 * @returns {Promise<{ response: object, costUsd: number }>} response is sent back to the LLM as the function result
 */
async function analyzeAudio(groupId, args = {}) {
    const audioId = String(args.audio_id || '').trim();
    const task = args.task === 'ask' ? 'ask' : 'transcribe';
    const question = String(args.question || '').trim();

    if (!AUDIO_ID_PATTERN.test(audioId)) {
        return { response: { error: `Invalid audio id "${audioId}". Use an id like audio_1772209104664 from the message history.` }, costUsd: 0 };
    }
    if (task === 'ask' && !question) {
        return { response: { error: 'task "ask" requires a question.' }, costUsd: 0 };
    }

    // Only voice notes from this chat can be analyzed
    const record = await conversationStore.getAudioRecord(groupId, audioId);
    if (!record) {
        return { response: { error: `No voice note ${audioId} in this chat.` }, costUsd: 0 };
    }

    if (task === 'transcribe' && record.audio_transcript) {
        logger.info('Audio', `analyze_audio: cached transcript for ${audioId}`);
        return { response: { audio_id: audioId, duration: formatDuration(record.audio_duration), transcript: record.audio_transcript }, costUsd: 0 };
    }

    const filePath = await findAudioFile(audioId);
    if (!filePath) {
        return { response: { error: `The audio file for ${audioId} is no longer available.` }, costUsd: 0 };
    }

    try {
        const duration = record.audio_duration || await probeDuration(filePath);
        const maxSeconds = config.audioAnalysisMaxSeconds;
        const truncated = !duration || duration > maxSeconds;
        const audio = await loadAudio(filePath, duration, maxSeconds);

        const result = await callAudioModel(audio, task === 'transcribe' ? TRANSCRIBE_PROMPT : QUESTION_PROMPT(question), config.audioAnalysisModel, config.audioAnalysisThinkingLevel);
        logger.info('Audio', `analyze_audio (${task}) on ${audioId}: ${result.inputTokens} in / ${result.outputTokens} out, $${result.costUsd.toFixed(6)}`);

        const response = { audio_id: audioId, duration: formatDuration(duration) };
        if (truncated && duration) response.note = `Only the first ${formatDuration(maxSeconds)} of this ${formatDuration(duration)} voice note were analyzed.`;
        if (task === 'transcribe') {
            response.transcript = result.text;
            // Cache complete transcripts so later requests don't re-process the audio
            if (!truncated && result.text) await conversationStore.setAudioTranscript(audioId, result.text);
        } else {
            response.answer = result.text;
        }
        return { response, costUsd: result.costUsd };
    } catch (err) {
        logger.error('Audio', `analyze_audio failed for ${audioId}: ${err.message}`);
        return { response: { error: `Could not analyze ${audioId}: ${err.message}` }, costUsd: 0 };
    }
}

/**
 * Loads a stored voice note as a Gemini inline audio part, trimmed to the hard cap
 * (AUDIO_ANALYSIS_MAX_SECONDS). Used when audio is attached directly to an LLM call.
 * @returns {Promise<{ part: object, duration: number, truncated: boolean }|null>} null if the file is missing
 */
async function loadAudioPart(audioId) {
    const filePath = await findAudioFile(audioId);
    if (!filePath) return null;
    const duration = await probeDuration(filePath);
    const maxSeconds = config.audioAnalysisMaxSeconds;
    const audio = await loadAudio(filePath, duration, maxSeconds);
    return {
        part: { inlineData: { mimeType: audio.mimeType, data: audio.data.toString('base64') } },
        duration,
        truncated: !duration || duration > maxSeconds
    };
}

module.exports = { loadAudioPart, ANALYZE_AUDIO_TOOL, analyzeAudio, transcribePreview, formatDuration, AUDIO_ID_PATTERN };
