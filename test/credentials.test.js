const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');

const SA = { type: 'service_account', project_id: 'test-project', client_email: 'bot@test-project.iam.gserviceaccount.com' };
const saFile = path.join(os.tmpdir(), `wispbot-sa-${process.pid}.json`);
fs.writeFileSync(saFile, JSON.stringify(SA));

const saved = {
    apiKey: process.env.GEMINI_API_KEY,
    json: config.googleServiceAccountJson,
    file: config.googleServiceAccountFile,
    auth: config.geminiAuth
};

// credentials.js caches the parsed service account, so load a fresh copy per test
function loadCredentials({ apiKey = '', json = '', file = '', auth = '' } = {}) {
    if (apiKey) process.env.GEMINI_API_KEY = apiKey; else delete process.env.GEMINI_API_KEY;
    config.googleServiceAccountJson = json;
    config.googleServiceAccountFile = file;
    config.geminiAuth = auth;
    delete require.cache[require.resolve('../src/ai/credentials')];
    return require('../src/ai/credentials');
}

describe('Gemini credentials', () => {
    beforeEach(() => loadCredentials());

    after(() => {
        if (saved.apiKey) process.env.GEMINI_API_KEY = saved.apiKey; else delete process.env.GEMINI_API_KEY;
        config.googleServiceAccountJson = saved.json;
        config.googleServiceAccountFile = saved.file;
        config.geminiAuth = saved.auth;
        fs.rmSync(saFile, { force: true });
    });

    it('returns null when nothing is configured', () => {
        const creds = loadCredentials();
        assert.equal(creds.getAuthMode(), null);
        assert.equal(creds.hasGeminiCredentials(), false);
    });

    it('uses the API key when only a key is set', () => {
        assert.equal(loadCredentials({ apiKey: 'key' }).getAuthMode(), 'api_key');
    });

    it('prefers the service account file when both are set', () => {
        const creds = loadCredentials({ apiKey: 'key', file: saFile });
        assert.equal(creds.getAuthMode(), 'service_account');
        assert.equal(creds.loadServiceAccount().project_id, 'test-project');
    });

    it('reads inline service account JSON', () => {
        assert.equal(loadCredentials({ json: JSON.stringify(SA) }).getAuthMode(), 'service_account');
    });

    it('honors GEMINI_AUTH=api_key even when a service account is set', () => {
        assert.equal(loadCredentials({ apiKey: 'key', file: saFile, auth: 'api_key' }).getAuthMode(), 'api_key');
    });

    it('returns null when the forced mode has no credentials', () => {
        assert.equal(loadCredentials({ apiKey: 'key', auth: 'service_account' }).getAuthMode(), null);
    });

    it('treats an unreadable key file as no service account', () => {
        assert.equal(loadCredentials({ file: path.join(os.tmpdir(), 'does-not-exist.json') }).getAuthMode(), null);
    });
});
