const commands = new Map();

function register(name, handler, { adminOnly = true, public: isPublic = false } = {}) {
    commands.set(name, { handler, adminOnly, public: isPublic });
}

async function dispatch(command, client, message, config) {
    const cmd = commands.get(command);
    if (!cmd) {
        const available = Array.from(commands.keys()).join(', ');
        await client.sendMessage(message.from, `Unknown command. Available commands: ${available}`);
        return;
    }
    return cmd.handler(client, message, config);
}

// Export before requiring command files so they can call register()
module.exports = { register, dispatch, commands };

// Self-registering command files
require('./ping');
require('./clear');
require('./usage');
require('./help');
require('./stop');
require('./start');
require('./addme');
require('./persona');
