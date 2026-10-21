const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { lidToPhone, registerLidMapping, resolveLid, isBotMentionedIn } = require('../src/lid-utils');

describe('LID mapping', () => {
    beforeEach(() => lidToPhone.clear());

    it('resolves a bare LID registered with a device suffix', () => {
        // The bot's own session LID has a device suffix; mentions use the bare LID
        registerLidMapping('29747346149485:64@lid', '212611089866:64@s.whatsapp.net');
        assert.equal(resolveLid('29747346149485@lid'), '212611089866@s.whatsapp.net');
    });

    it('resolves a LID that itself carries a device suffix', () => {
        registerLidMapping('111@lid', '222@s.whatsapp.net');
        assert.equal(resolveLid('111:3@lid'), '222@s.whatsapp.net');
    });

    it('leaves unknown LIDs and phone JIDs unchanged', () => {
        assert.equal(resolveLid('999@lid'), '999@lid');
        assert.equal(resolveLid('222@s.whatsapp.net'), '222@s.whatsapp.net');
        assert.equal(resolveLid(null), null);
    });
});

describe('isBotMentionedIn', () => {
    const config = { botUserId: '212611089866@c.us', botName: 'Wispbot', botNumber: '212611089866', botLidNumber: '29747346149485' };

    it('detects a mention by resolved id', () => {
        assert.equal(isBotMentionedIn({ mentionedIds: ['212611089866@c.us'], body: 'hi' }, config), true);
    });

    it('detects a mention by LID in the text even when the id did not resolve', () => {
        const message = { mentionedIds: ['29747346149485@lid'], body: '@29747346149485 وا فين هاد الغبور اصاحبي' };
        assert.equal(isBotMentionedIn(message, config), true);
    });

    it('detects @name and @number in the text', () => {
        assert.equal(isBotMentionedIn({ body: 'hey @Wispbot' }, config), true);
        assert.equal(isBotMentionedIn({ body: 'hey @212611089866' }, config), true);
    });

    it('ignores messages that tag someone else', () => {
        assert.equal(isBotMentionedIn({ mentionedIds: ['17747620729@c.us'], body: '@17747620729 hi' }, config), false);
    });

    it('does not match on empty identity fields', () => {
        assert.equal(isBotMentionedIn({ body: 'email me @ noon' }, { botUserId: 'x@c.us', botName: '', botNumber: '', botLidNumber: '' }), false);
    });
});
