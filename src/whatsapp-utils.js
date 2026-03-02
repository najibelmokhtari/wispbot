const { jidNormalizedUser, isJidGroup } = require('@whiskeysockets/baileys');

/**
 * Convert a Baileys JID to the @c.us format stored in the database.
 * "1234567890@s.whatsapp.net" → "1234567890@c.us"
 * Groups (@g.us) and LIDs (@lid) pass through unchanged.
 */
function jidToDbId(jid) {
    if (!jid) return jid;
    return jid.replace('@s.whatsapp.net', '@c.us');
}

/**
 * Convert a DB ID (@c.us format) back to a Baileys JID.
 * "1234567890@c.us" → "1234567890@s.whatsapp.net"
 */
function dbIdToJid(dbId) {
    if (!dbId) return dbId;
    return dbId.replace('@c.us', '@s.whatsapp.net');
}

/**
 * Extract phone number from any WhatsApp ID format.
 */
function extractNumber(id) {
    if (!id) return null;
    return id.split(':')[0].split('@')[0];
}

/**
 * Get the bot's normalized user ID from the socket.
 */
function getBotId(sock) {
    if (!sock.user?.id) return null;
    return jidNormalizedUser(sock.user.id);
}

module.exports = { jidToDbId, dbIdToJid, extractNumber, getBotId, isJidGroup };
