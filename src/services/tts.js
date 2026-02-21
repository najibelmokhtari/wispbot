const axios = require('axios');
const { calculateTTSCost } = require('../pricing-config');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const logger = require('../logger');

const execAsync = promisify(exec);

// Constants
const DEFAULT_SAMPLE_RATE_HERTZ = 24000;
// Note: API URL changed to Generative Language API
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

class TTSService {
    constructor(config) {
        // Load API Key from environment variables
        this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

        if (!this.apiKey) {
            logger.error('TTS', "No API Key found for TTS Service (GEMINI_API_KEY or GOOGLE_API_KEY)");
        }

        // Configuration
        this.modelName = 'gemini-2.5-pro-preview-tts'; // Generative model specified by user
        this.defaultVoice = {
            name: 'Kore' // Specific Voice ID for Gemini TTS
        };
    }

    /**
     * Helper to write a WAV header for PCM data.
     * @param {Buffer} pcmData - Raw PCM data
     * @param {number} sampleRate - Sample rate in Hz (e.g., 24000)
     * @param {number} numChannels - Number of channels (e.g., 1 for mono)
     * @param {number} bitDepth - Bit depth (e.g., 16)
     * @returns {Buffer} WAV file buffer
     */
    _addWavHeader(pcmData, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
        const header = Buffer.alloc(44);
        const dataLength = pcmData.length;
        const fileSize = dataLength + 36;
        const bytesPerSample = bitDepth / 8;
        const byteRate = sampleRate * numChannels * bytesPerSample;
        const blockAlign = numChannels * bytesPerSample;

        // RIFF chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitDepth, 34);

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * Converts WAV buffer to OGG/Opus using ffmpeg (WhatsApp's native voice format).
     * @param {Buffer} wavBuffer - WAV audio buffer
     * @returns {Promise<Buffer>} OGG/Opus audio buffer
     */
    async _convertToOgg(wavBuffer) {
        const tempId = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const tempDir = os.tmpdir();
        const wavPath = path.join(tempDir, `${tempId}.wav`);
        const oggPath = path.join(tempDir, `${tempId}.ogg`);

        try {
            // Write WAV to temp file
            await fs.writeFile(wavPath, wavBuffer);

            // Convert to OGG/Opus using ffmpeg (WhatsApp's native voice note format)
            await execAsync(`ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${oggPath}"`);

            // Read OGG file
            const oggBuffer = await fs.readFile(oggPath);
            return oggBuffer;
        } finally {
            // Cleanup temp files
            await fs.unlink(wavPath).catch(() => {});
            await fs.unlink(oggPath).catch(() => {});
        }
    }

    /**
     * Generates audio from text using Gemini Generative API.
     * @param {string} text - The text to speak.
     * @param {object} options - Options: { stylePrompt: string }
     */
    async generateAudio(text, options = {}) {
        const stylePrompt = options.stylePrompt;
        const voiceName = options.voice || this.defaultVoice.name;

        // Construct the content with style prompt if available
        let contentInput = text;
        if (stylePrompt) {
            contentInput = `${stylePrompt}: ${text}`;
        }

        // Construct payload for Gemini Generative API
        const payload = {
            contents: [{
                parts: [{ text: contentInput }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voiceName
                        }
                    }
                }
            }
        };

        try {
            if (!this.apiKey) {
                throw new Error("TTS Service: API Key is missing.");
            }

            // Construct API URL
            const url = `${BASE_URL}/${this.modelName}:generateContent?key=${this.apiKey}`;

            const response = await axios.post(url, payload, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 90000
            });

            if (response.status !== 200) {
                throw new Error(`TTS API Error: ${response.status} ${response.statusText}`);
            }

            // Extract inline audio data
            // Response structure: candidates[0].content.parts[0].inlineData.data
            const candidate = response.data.candidates && response.data.candidates[0];
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
            const charCount = text.length; // Simplified; actual cost includes prompt
            const cost = calculateTTSCost(this.modelName, charCount);

            return {
                audioBase64: audioContent,
                costUsd: cost,
                charCount: charCount
            };

        } catch (error) {
            logger.error('TTS', 'Error generating TTS: ' + (error.response ? JSON.stringify(error.response.data, null, 2) : error.message));
            throw error;
        }
    }
}

module.exports = TTSService;