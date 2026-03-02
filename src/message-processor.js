const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { replacePhoneNumbersWithUsernames } = require('./phone-number-replacer');

function truncateMessage(message, maxLength = 100) {
    if (typeof message !== 'string') {
        return '';
    }
    if (message.length <= maxLength) {
        return message;
    }
    return message.substring(0, maxLength) + '...';
}

function removeExtendedHistoryCode(message, code) {
    return message.replace(code, '').trim();
}

function formatQuotedMessage(msg, config) {
    if (!msg || typeof msg !== 'object') {
        return '';
    }

    let formattedMessage = msg.message || '';

    // Remove the extended history code if present
    formattedMessage = removeExtendedHistoryCode(formattedMessage, config.extendedHistoryCode);

    // Format: "timestamp - alias: message" (no raw IDs — LLM only sees names)
    const senderAlias = replacePhoneNumbersWithUsernames(msg.sender);
    let result = `${msg.timestamp} - ${senderAlias}: ${formattedMessage}`;

    if (msg.quotedMsg) {
        let quotedContent = msg.quotedMsg.body;
        if (msg.quotedMsg.imageId) {
            quotedContent = `Image: ${msg.quotedMsg.imageId}`;
        } else if (msg.quotedMsg.audioId) {
            quotedContent = `Audio: ${msg.quotedMsg.audioId}`;
        }
        const truncatedQuote = truncateMessage(quotedContent);
        const quotedAlias = replacePhoneNumbersWithUsernames(msg.quotedParticipant);
        result += `\n    Quoted: ${quotedAlias}: ${truncatedQuote}`;
    }

    if (msg.imageId) {
        result += ` (Image: ${msg.imageId})`;
    }

    if (msg.audio_id) {
        result += ` (Audio: ${msg.audio_id})`;
    }

    return result;
}

function processMessageHistory(recentMessages, config) {
    if (!Array.isArray(recentMessages)) {
        logger.error('MsgProcessor', 'Invalid recentMessages array');
        return '';
    }
    return recentMessages.map(msg => formatQuotedMessage(msg, config)).join('\n');
}

async function addToHistory(messageHistory, groupId, sender, message, imageBuffer = null, quotedMsg = null, config, imageId = null, quotedParticipant = null) {
    if (!messageHistory || !(messageHistory instanceof Map)) {
        logger.error('MsgProcessor', 'Invalid messageHistory object');
        return null;
    }

    if (!config || typeof config !== 'object') {
        logger.error('MsgProcessor', 'Invalid config object');
        return null;
    }

    if (!messageHistory.has(groupId)) {
        messageHistory.set(groupId, []);
    }
    let groupHistory = messageHistory.get(groupId);

    const historyEntry = {
        sender: sender,
        message: message,
        timestamp: new Date().toISOString(),
        quotedMsg: quotedMsg ? {
            sender: replacePhoneNumbersWithUsernames(quotedParticipant || quotedMsg.sender || quotedMsg.author),
            message: quotedMsg.body,
            timestamp: quotedMsg.t ? new Date(quotedMsg.t * 1000).toISOString() : new Date().toISOString(),
            imageId: quotedMsg.type === 'image' ? imageId : null
        } : null,
        imageId: imageId
    };

    groupHistory.push(historyEntry);
    if (groupHistory.length > config.messageHistoryLimit) {
        groupHistory = groupHistory.slice(-config.messageHistoryLimit);
    }
    messageHistory.set(groupId, groupHistory);
    return historyEntry;
}

module.exports = {
    processMessageHistory,
    addToHistory,
    removeExtendedHistoryCode
};