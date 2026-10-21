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
     * Generates audio from text using the shared Gemini client.
     */
    async generateAudio(text, options = {}) {
        const stylePrompt = options.stylePrompt;
        const voiceName = options.voice || this.defaultVoice.name;

        let contentInput = text;
        if (stylePrompt) {
            contentInput = `${stylePrompt}: ${text}`;
        }

        const genAI = getGenAI();
        if (!genAI) {
            throw new Error('TTS Service: Gemini credentials not configured.');
        }

        try {
            const response = await genAI.models.generateContent({
                model: this.modelName,
                contents: [{ role: 'user', parts: [{ text: contentInput }] }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: voiceName }
                        }
                    }
                }
            });

            // Extract inline audio data
            const candidate = response.candidates && response.candidates[0];
            const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];

            if (!part || !part.inlineData || !part.inlineData.data) {
                throw new Error("No inline audio data found in Gemini response.");
            }

            const rawPcmBase64 = part.inlineData.data;
            const pcmBuffer = Buffer.from(rawPcmBase64, 'base64');

            // Wrap in WAV container (16-bit, 24kHz, mono)
            const wavBuffer = this._addWavHeader(pcmBuffer, DEFAULT_SAMPLE_RATE_HERTZ, 1, 16);

            // Convert WAV to OGG/Opus for WhatsApp compatibility
            const oggBuffer = await this._convertToOgg(wavBuffer);
            const audioContent = oggBuffer.toString('base64');

            // Calculate Cost
            const charCount = text.length;
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
