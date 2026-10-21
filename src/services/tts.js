const axios = require('axios');
const { calculateTTSCost } = require('../pricing-config');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const logger = require('../logger');
const config = require('../config');

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
const DEV_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

class TTSService {
    constructor() {
        this.provider = config.ttsProvider; // 'dev' or 'vertex'
        this.modelName = config.ttsModel;
        this.defaultVoice = { name: 'Kore' };

        if (this.provider === 'vertex') {
            this._initVertex();
        } else {
            this._initDev();
        }

        // Check ffmpeg availability at startup (non-blocking)
        checkFfmpeg();
    }

    _initDev() {
        this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!this.apiKey) {
            logger.error('TTS', "No API Key found for TTS (dev mode). Set GEMINI_API_KEY.");
        }
        logger.info('TTS', `Initialized TTS with dev API (model: ${this.modelName})`);
    }

    _initVertex() {
        this._serviceAccount = null;
        this._accessToken = null;
        this._tokenExpiry = 0;

        let rawJson = config.googleServiceAccountJson;
        if (!rawJson && config.googleServiceAccountFile) {
            try {
                rawJson = require('fs').readFileSync(config.googleServiceAccountFile, 'utf8');
            } catch (err) {
                logger.error('TTS', `Failed to read GOOGLE_SERVICE_ACCOUNT_FILE (${config.googleServiceAccountFile}): ${err.message}`);
                return;
            }
        }

        if (!rawJson) {
            logger.error('TTS', "No service account found. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE for Vertex AI TTS.");
            return;
        }

        try {
            this._serviceAccount = JSON.parse(rawJson);
            this._projectId = this._serviceAccount.project_id;
            this._region = config.vertexRegion;
            logger.info('TTS', `Initialized TTS with Vertex AI (project: ${this._projectId}, region: ${this._region}, model: ${this.modelName})`);
        } catch (err) {
            logger.error('TTS', 'Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ' + err.message);
        }
    }

    /**
     * Get an OAuth2 access token from the service account for Vertex AI.
     */
    async _getVertexAccessToken() {
        // Return cached token if still valid (with 60s buffer)
        if (this._accessToken && Date.now() < this._tokenExpiry - 60000) {
            return this._accessToken;
        }

        const crypto = require('crypto');
        const sa = this._serviceAccount;

        // Build JWT
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        })).toString('base64url');

        const signInput = `${header}.${payload}`;
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(signInput);
        const signature = sign.sign(sa.private_key, 'base64url');
        const jwt = `${signInput}.${signature}`;

        // Exchange JWT for access token
        const resp = await axios.post(sa.token_uri || 'https://oauth2.googleapis.com/token', new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        this._accessToken = resp.data.access_token;
        this._tokenExpiry = Date.now() + (resp.data.expires_in * 1000);
        return this._accessToken;
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
     * Build the Gemini TTS request payload (same structure for both providers).
     */
    _buildPayload(contentInput, voiceName) {
        return {
            contents: [{
                role: "user",
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
    }

    /**
     * Call the Dev (Generative Language) API.
     */
    async _callDevApi(payload) {
        if (!this.apiKey) {
            throw new Error("TTS Service: GEMINI_API_KEY is missing.");
        }
        const url = `${DEV_BASE_URL}/${this.modelName}:generateContent?key=${this.apiKey}`;
        return axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000
        });
    }

    /**
     * Call the Vertex AI API.
     */
    async _callVertexApi(payload) {
        if (!this._serviceAccount) {
            throw new Error("TTS Service: Service account not configured for Vertex AI.");
        }
        const token = await this._getVertexAccessToken();
        // The 'global' location has no regional prefix on the hostname
        const host = this._region === 'global' ? 'aiplatform.googleapis.com' : `${this._region}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1/projects/${this._projectId}/locations/${this._region}/publishers/google/models/${this.modelName}:generateContent`;
        return axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            timeout: 90000
        });
    }

    /**
     * Generates audio from text using either Dev or Vertex AI API.
     */
    async generateAudio(text, options = {}) {
        const stylePrompt = options.stylePrompt;
        const voiceName = options.voice || this.defaultVoice.name;

        let contentInput = text;
        if (stylePrompt) {
            contentInput = `${stylePrompt}: ${text}`;
        }

        const payload = this._buildPayload(contentInput, voiceName);

        try {
            const response = this.provider === 'vertex'
                ? await this._callVertexApi(payload)
                : await this._callDevApi(payload);

            if (response.status !== 200) {
                throw new Error(`TTS API Error: ${response.status} ${response.statusText}`);
            }

            // Extract inline audio data
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
            const charCount = text.length;
            const cost = calculateTTSCost(this.modelName, charCount);

            return {
                audioBase64: audioContent,
                costUsd: cost,
                charCount: charCount
            };

        } catch (error) {
            logger.error('TTS', `Error generating TTS (${this.provider}): ` + (error.response ? JSON.stringify(error.response.data, null, 2) : error.message));
            throw error;
        }
    }
}

module.exports = TTSService;
