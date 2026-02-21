const { setUserAuthorized, isUserAuthorized } = require('../db');

/**
 * Authorize all participants in a group chat.
 * Returns { newUserIds: string[], totalParticipants: number }
 */
async function authorizeGroupParticipants(chat) {
    if (!chat.isGroup) {
        throw new Error('This command can only be used in group chats.');
    }

    const participants = chat.participants;
    if (!participants || participants.length === 0) {
        return { newUserIds: [], totalParticipants: 0 };
    }

    const participantIds = participants.map(p => p.id._serialized);
    const newUserIds = [];

    for (const id of participantIds) {
        if (await isUserAuthorized(id)) continue;
        await setUserAuthorized(id, true);
        newUserIds.push(id);
    }

    return { newUserIds, totalParticipants: participants.length };
}

module.exports = { authorizeGroupParticipants };
