const { calculateTTSCost } = require('../pricing-config');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const logger = require('../logger');
const config = require('../config');
const { getGenAI } = require('../ai/gemini');

const execAsync = promisify(exec);

let ffmpegChecked = false;
let ffmpegAvailable = false;

async function checkFfmpeg() {
    if (ffmpegChecked) return ffmpegAvailable;
    ffmpegChecked = true;
    try {
        await execAsync('ffmpeg -version');
        ffmpegAvailable = true;
    } catch {
        ffmpegAvailable = false;
        logger.error('TTS', 'ffmpeg is not installed or not in PATH. TTS requires ffmpeg for audio conversion. Install it with: brew install ffmpeg (macOS), sudo apt install ffmpeg (Ubuntu/Debian), or download from https://ffmpeg.org/download.html');
    }
    return ffmpegAvailable;
}

// Constants
const DEFAULT_SAMPLE_RATE_HERTZ = 24000;

class TTSService {
    constructor() {
        this.modelName = config.ttsModel;
        this.defaultVoice = { name: 'Kore' };

        // Uses the shared Gemini client, so TTS follows the same auth (API key or service account)
        logger.info('TTS', `Initialized TTS (model: ${this.modelName})`);

        // Check ffmpeg availability at startup (non-blocking)
        checkFfmpeg();
    }

    /**
     * Helper to write a WAV header for PCM data.
     */
    _addWavHeader(pcmData, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
        const header = Buffer.alloc(44);
        const dataLength = pcmData.length;
        const fileSize = dataLength + 36;
        const bytesPerSample = bitDepth / 8;
        const byteRate = sampleRate * numChannels * bytesPerSample;
        const blockAlign = numChannels * bytesPerSample;

        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitDepth, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * Converts WAV buffer to OGG/Opus using ffmpeg.
     */
    async _convertToOgg(wavBuffer) {
        if (!await checkFfmpeg()) {
            throw new Error('ffmpeg is not installed. TTS requires ffmpeg for WAV-to-OGG conversion. See logs for install instructions.');
        }
        const tempId = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const tempDir = os.tmpdir();
        const wavPath = path.join(tempDir, `${tempId}.wav`);
        const oggPath = path.join(tempDir, `${tempId}.ogg`);

        try {
            await fs.writeFile(wavPath, wavBuffer);
            await execAsync(`ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${oggPath}"`);
            const oggBuffer = await fs.readFile(oggPath);
            return oggBuffer;
        } finally {
            await fs.unlink(wavPath).catch(() => {});
            await fs.unlink(oggPath).catch(() => {});
        }
    }

    /**
     * Whether the model takes per-part styles via speechMetadata (Gemini 3.8 TTS and later).
     * Older models (2.5) only understand a style prefixed to the text.
     */
    _supportsSpeechMetadata() {
        return !/gemini-2\.5/i.test(this.modelName);
    }

    /**
     * Builds the request parts from voice script segments.
     */
    _buildParts(segments, defaultStyle) {
        if (this._supportsSpeechMetadata()) {
            return segments.map(seg => {
                const style = seg.style || defaultStyle;
                return style ? { text: seg.text, speechMetadata: { style } } : { text: seg.text };
            });
        }
        // Legacy models: one part, the first style spoken as a prefix instruction
        const style = (segments.find(s => s.style) || {}).style || defaultStyle;
        const text = segments.map(s => s.text).join('\n');
        return [{ text: style ? `${style}: ${text}` : text }];
    }

    /**
     * Generates audio using the shared Gemini client.
     * @param {string|{text: string, style: string|null}[]} input - Plain text or voice script segments
     * @param {{voice?: string, defaultStyle?: string}} options - defaultStyle applies to segments without a style
     */
    async generateAudio(input, options = {}) {
        const segments = typeof input === 'string' ? [{ text: input, style: null }] : input;
        const voiceName = options.voice || this.defaultVoice.name;

        const genAI = getGenAI();
        if (!genAI) {
            throw new Error('TTS Service: Gemini credentials not configured.');
        }

        const voiceConfig = this._supportsSpeechMetadata()
            ? { voice: voiceName }
            : { prebuiltVoiceConfig: { voiceName: voiceName } };

        try {
            const response = await genAI.models.generateContent({
                model: this.modelName,
                contents: [{ role: 'user', parts: this._buildParts(segments, options.defaultStyle || null) }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig }
                }
            });

            // Extract inline audio data
            const candidate = response.candidates && response.candidates[0];
            const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];

            if (!part || !part.inlineData || !part.inlineData.data) {
                throw new Error("No inline audio data found in Gemini response.");
            }

            const audioBuffer = Buffer.from(part.inlineData.data, 'base64');

            // 3.8 TTS returns a complete WAV file; older models return raw 16-bit PCM that needs a header
            const isWav = audioBuffer.subarray(0, 4).toString('latin1') === 'RIFF';
            const rateMatch = (part.inlineData.mimeType || '').match(/rate=(\d+)/);
            const wavBuffer = isWav
                ? audioBuffer
                : this._addWavHeader(audioBuffer, rateMatch ? parseInt(rateMatch[1], 10) : DEFAULT_SAMPLE_RATE_HERTZ, 1, 16);

            // Convert WAV to OGG/Opus for WhatsApp compatibility
            const oggBuffer = await this._convertToOgg(wavBuffer);
            const audioContent = oggBuffer.toString('base64');

            // Calculate Cost
            const charCount = segments.reduce((n, s) => n + s.text.length, 0);
            const cost = calculateTTSCost(this.modelName, charCount);

            return {
                audioBase64: audioContent,
                costUsd: cost,
                charCount: charCount
            };

        } catch (error) {
            logger.error('TTS', 'Error generating TTS: ' + error.message);
            throw error;
        }
    }
}

module.exports = TTSService;
