const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// --- LID-to-phone mapping (populated from Baileys events) ---
const lidToPhone = new Map(); // LID JID → phone JID (e.g. "123@lid" → "456@s.whatsapp.net")

function registerLidMapping(lid, phoneJid) {
    if (!lid || !phoneJid) return;
    // Mentions use the bare LID ("123@lid"), the session may include a device suffix ("123:64@lid")
    const normalizedLid = jidNormalizedUser(lid);
    const normalizedPhone = jidNormalizedUser(phoneJid);
    if (normalizedLid && normalizedPhone && normalizedLid !== normalizedPhone) {
        lidToPhone.set(normalizedLid, normalizedPhone);
    }
}

/** Resolve a JID — if it's a LID, return the phone JID; otherwise return as-is */
function resolveLid(jid) {
    if (!jid) return jid;
    if (jid.endsWith('@lid')) {
        const normalized = jidNormalizedUser(jid);
        if (lidToPhone.has(normalized)) return lidToPhone.get(normalized);
    }
    return jid;
}

/**
 * Whether a message tags the bot: by resolved mention id, or by @name / @number / @LID in the text.
 * @param {{ mentionedIds?: string[], body?: string }} message
 * @param {{ botUserId?: string, botName?: string, botNumber?: string, botLidNumber?: string }} config
 */
function isBotMentionedIn(message, config) {
    const mentionedIds = message.mentionedIds || [];
    const body = message.body || '';
    return mentionedIds.includes(config.botUserId)
        || (!!config.botName && body.includes(`@${config.botName}`))
        || (!!config.botNumber && body.includes(`@${config.botNumber}`))
        || (!!config.botLidNumber && body.includes(`@${config.botLidNumber}`));
}

module.exports = { lidToPhone, registerLidMapping, resolveLid, isBotMentionedIn };
