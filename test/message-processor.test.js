const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { removeExtendedHistoryCode } = require('../src/message-processor');

describe('removeExtendedHistoryCode', () => {
    it('removes the code substring and trims', () => {
        const message = '  Hello CODE123 world  ';
        assert.equal(removeExtendedHistoryCode(message, 'CODE123'), 'Hello  world');
    });

    it('returns trimmed message if code is not present', () => {
        assert.equal(removeExtendedHistoryCode('  hello  ', 'NOPE'), 'hello');
    });

    it('handles empty code', () => {
        assert.equal(removeExtendedHistoryCode('hello', ''), 'hello');
    });
});
