const commands = new Map();

function register(name, handler, { adminOnly = true } = {}) {
    commands.set(name, { handler, adminOnly });
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
module.exports = { register, dispatch };

// Self-registering command files
require('./ping');
require('./switch');
require('./search');
require('./tts');
require('./clear');
require('./remember');
require('./usage');
require('./list-messages');
require('./list-add-requests');
require('./accept-all-add-requests');
require('./accept-add-request');
require('./group-id');
require('./set-group-name');
require('./setup-group');
require('./audio');
require('./model');
require('./authorize-all');
require('./check-authorized');
