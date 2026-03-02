const logger = require('./logger');
const phoneToUsernameMap = new Map();

function replacePhoneNumbersWithUsernames(text) {
    if (typeof text !== 'string') return text;

    return text.replace(/(\d+@c\.us|\d{7,15})/g, (match) => {
        const fullId = match.includes('@c.us') ? match : `${match}@c.us`;
        if (phoneToUsernameMap.has(fullId)) {
            return phoneToUsernameMap.get(fullId);
        }
        return match; // If no username is found, return the original match
    });
}

function addPhoneToUsernameMapping(phoneNumber, username) {
    // Ensure the phoneNumber always has the @c.us suffix
    const fullId = phoneNumber.endsWith('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
    phoneToUsernameMap.set(fullId, username);
}

function prepareMessagesForClaude(formattedMessages) {
    if (typeof formattedMessages !== 'string') {
        logger.error('PhoneReplacer', 'Expected string input for prepareMessagesForClaude');
        return formattedMessages;
    }
    
    return replacePhoneNumbersWithUsernames(formattedMessages);
}

module.exports = {
    replacePhoneNumbersWithUsernames,
    addPhoneToUsernameMapping,
    prepareMessagesForClaude
};