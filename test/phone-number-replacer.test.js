const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module for each test file to avoid shared state issues
const {
    replacePhoneNumbersWithUsernames,
    addPhoneToUsernameMapping,
    prepareMessagesForClaude
} = require('../src/phone-number-replacer');

describe('phone-number-replacer', () => {
    // Seed some mappings (these accumulate across tests, which is fine)
    it('addPhoneToUsernameMapping stores mappings', () => {
        addPhoneToUsernameMapping('212600000001', 'Alice');
        addPhoneToUsernameMapping('212600000002@c.us', 'Bob');

        // Verify via replacement
        assert.equal(
            replacePhoneNumbersWithUsernames('Message from 212600000001@c.us'),
            'Message from Alice'
        );
        assert.equal(
            replacePhoneNumbersWithUsernames('Message from 212600000002@c.us'),
            'Message from Bob'
        );
    });

    it('replaces bare phone numbers that match', () => {
        addPhoneToUsernameMapping('212600000003', 'Charlie');
        assert.equal(
            replacePhoneNumbersWithUsernames('Call 212600000003 now'),
            'Call Charlie now'
        );
    });

    it('leaves unmatched numbers untouched', () => {
        const text = 'Unknown 9999999999@c.us here';
        assert.equal(replacePhoneNumbersWithUsernames(text), text);
    });

    it('returns non-string input as-is', () => {
        assert.equal(replacePhoneNumbersWithUsernames(42), 42);
        assert.equal(replacePhoneNumbersWithUsernames(null), null);
    });

    it('prepareMessagesForClaude delegates to replacer', () => {
        addPhoneToUsernameMapping('212600000004', 'Diana');
        const result = prepareMessagesForClaude('212600000004@c.us said hi');
        assert.equal(result, 'Diana said hi');
    });
});
