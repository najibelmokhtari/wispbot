const fs = require('fs');
const logger = require('../logger');
const config = require('../config');

let cachedServiceAccount;

/**
 * Loads the Google service account from GOOGLE_SERVICE_ACCOUNT_JSON (inline)
 * or GOOGLE_SERVICE_ACCOUNT_FILE (path). Returns null if neither is usable.
 */
function loadServiceAccount() {
    if (cachedServiceAccount !== undefined) return cachedServiceAccount;
    cachedServiceAccount = null;

    let rawJson = config.googleServiceAccountJson;
    if (!rawJson && config.googleServiceAccountFile) {
        try {
            rawJson = fs.readFileSync(config.googleServiceAccountFile, 'utf8');
        } catch (err) {
            logger.error('Credentials', `Failed to read GOOGLE_SERVICE_ACCOUNT_FILE (${config.googleServiceAccountFile}): ${err.message}`);
            return null;
        }
    }
    if (!rawJson) return null;

    try {
        cachedServiceAccount = JSON.parse(rawJson);
    } catch (err) {
        logger.error('Credentials', 'Failed to parse service account JSON: ' + err.message);
    }
    return cachedServiceAccount;
}

/**
 * Decides how to authenticate Gemini calls.
 * GEMINI_AUTH=api_key|service_account forces a mode; otherwise a configured
 * service account wins, falling back to GEMINI_API_KEY.
 * @returns {'service_account'|'api_key'|null}
 */
function getAuthMode() {
    const forced = (config.geminiAuth || '').toLowerCase();
    if (forced === 'service_account') return loadServiceAccount() ? 'service_account' : null;
    if (forced === 'api_key') return process.env.GEMINI_API_KEY ? 'api_key' : null;
    if (loadServiceAccount()) return 'service_account';
    if (process.env.GEMINI_API_KEY) return 'api_key';
    return null;
}

/** True when Gemini calls can be authenticated one way or the other. */
function hasGeminiCredentials() {
    return getAuthMode() !== null;
}

module.exports = { loadServiceAccount, getAuthMode, hasGeminiCredentials };
