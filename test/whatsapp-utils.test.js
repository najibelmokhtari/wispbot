const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jidToDbId, dbIdToJid, extractNumber } = require('../src/whatsapp-utils');

describe('jidToDbId', () => {
    it('converts @s.whatsapp.net to @c.us', () => {
        assert.equal(jidToDbId('1234567890@s.whatsapp.net'), '1234567890@c.us');
    });

    it('leaves group JIDs unchanged', () => {
        assert.equal(jidToDbId('123456@g.us'), '123456@g.us');
    });

    it('returns falsy input as-is', () => {
        assert.equal(jidToDbId(null), null);
        assert.equal(jidToDbId(undefined), undefined);
        assert.equal(jidToDbId(''), '');
    });
});

describe('dbIdToJid', () => {
    it('converts @c.us to @s.whatsapp.net', () => {
        assert.equal(dbIdToJid('1234567890@c.us'), '1234567890@s.whatsapp.net');
    });

    it('leaves group IDs unchanged', () => {
        assert.equal(dbIdToJid('123456@g.us'), '123456@g.us');
    });

    it('returns falsy input as-is', () => {
        assert.equal(dbIdToJid(null), null);
    });
});

describe('extractNumber', () => {
    it('extracts number from @c.us format', () => {
        assert.equal(extractNumber('1234567890@c.us'), '1234567890');
    });

    it('extracts number from format with device suffix', () => {
        assert.equal(extractNumber('1234567890:0@c.us'), '1234567890');
    });

    it('returns null for falsy input', () => {
        assert.equal(extractNumber(null), null);
        assert.equal(extractNumber(''), null);
    });
});
