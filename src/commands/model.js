const { register } = require('./index');
const { getOrCreateGroupInfo, updateGroupInfo } = require('../db');
const conversationStore = require('../conversation-store');
const { AVAILABLE_MODELS, isValidModel, getAvailableModels } = require('../pricing-config');
const logger = require('../logger');

async function handler(client, message, config) {
    const parts = message.body.split(' ');
    const modelName = parts[1] ? parts[1].toLowerCase() : null;

    if (!modelName) {
        const groupInfo = await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');
        const currentModel = groupInfo.ai_model || config.aiModel || 'gemini-2.5-pro';
        const modelInfo = AVAILABLE_MODELS[currentModel];
        const displayName = modelInfo ? modelInfo.displayName : currentModel;

        const availableModels = getAvailableModels();
        const modelList = availableModels.map(m => {
            const info = AVAILABLE_MODELS[m];
            return `  - ${m} (${info.displayName}): ${info.description}`;
        }).join('\n');

        await client.sendMessage(
            message.from,
            `Current AI model: ${displayName} (${currentModel})\n\nAvailable models:\n${modelList}\n\nUse '!model <model-name>' to switch.`
        );
        return;
    }

    if (!isValidModel(modelName)) {
        const availableModels = getAvailableModels();
        await client.sendMessage(
            message.from,
            `Invalid model name: ${modelName}\n\nAvailable models: ${availableModels.join(', ')}\n\nUse '!model' to see full details.`
        );
        return;
    }

    try {
        await getOrCreateGroupInfo(message.from, message.dmContactName || 'Direct Message');

        await updateGroupInfo(message.from, { ai_model: modelName });

        const modelInfo = AVAILABLE_MODELS[modelName];
        const response = `AI model switched to: ${modelInfo.displayName} (${modelName})`;

        await client.sendMessage(message.from, response);
        await conversationStore.addMessageToConversation(message.from, {
            sender: config.botName,
            message: response,
            timestamp: new Date().toISOString(),
            quotedMsg: null,
            imageId: null,
            audioId: null
        });
        logger.info('Cmd', `Updated AI model for chat ${message.from} to ${modelName}`);
    } catch (error) {
        logger.error('Cmd', 'Error updating AI model: ' + error.message);
        await client.sendMessage(message.from, 'Error updating AI model.');
    }
}

register('!model', handler);
