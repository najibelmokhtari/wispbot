const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Fake the DB so the command can run without SQLite
const groups = new Map();
require.cache[require.resolve('../src/db')] = {
    exports: {
        getOrCreateGroupInfo: async (id) => groups.get(id) || { group_id: id, active_listening_enabled: 0 },
        updateGroupInfo: async (id, data) => { groups.set(id, { ...(groups.get(id) || { group_id: id }), ...data }); return true; }
    }
};

const { commands } = require('../src/commands/index');
const listen = commands.get('!listen').handler;

const GROUP = '123@g.us';
const sent = [];
const client = { sendMessage: async (to, text) => sent.push(text) };
const run = (body, from = GROUP) => listen(client, { from, body });
const state = () => groups.get(GROUP).active_listening_enabled;

describe('!listen', () => {
    beforeEach(() => {
        groups.clear();
        groups.set(GROUP, { group_id: GROUP, active_listening_enabled: 0 });
        sent.length = 0;
    });

    it('is registered as an admin-only command', () => {
        assert.equal(commands.get('!listen').adminOnly, true);
    });

    it('toggles on and off without arguments', async () => {
        await run('!listen');
        assert.equal(state(), 1);
        await run('!listen');
        assert.equal(state(), 0);
    });

    it('sets the state explicitly with on/off, case-insensitively', async () => {
        await run('!listen ON');
        assert.equal(state(), 1);
        await run('!listen off');
        assert.equal(state(), 0);
    });

    it('reports when the state is already set', async () => {
        await run('!listen off');
        assert.equal(state(), 0);
        assert.match(sent.at(-1), /already off/);
    });

    it('rejects unknown arguments', async () => {
        await run('!listen maybe');
        assert.equal(state(), 0);
        assert.match(sent.at(-1), /Usage/);
    });

    it('only works in groups', async () => {
        await run('!listen on', '123@s.whatsapp.net');
        assert.match(sent.at(-1), /only be used in groups/);
    });
});
