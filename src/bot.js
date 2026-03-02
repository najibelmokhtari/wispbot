// --- Baileys WhatsApp Bot ---
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, getContentType, jidNormalizedUser, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { addPhoneToUsernameMapping } = require('./phone-number-replacer');
const { jidToDbId, dbIdToJid, extractNumber, isJidGroup } = require('./whatsapp-utils');
const fs = require('fs').promises;
const path = require('path');
const { dispatch } = require('./commands');
const conversationStore = require('./conversation-store');
const MessageQueueManager = require('./message-queue');
const {
    getDatabase,
    closeDatabase,
    upsertUser,
    getOrCreateGroupInfo,
    updateGroupInfo,
    isUserAuthorized,
    isUserAdmin,
    importAuthFromFiles,
    getBotSetting,
    setBotSetting
} = require('./db');
const config = require('./config');
const logger = require('./logger');

const BackgroundProcessor = require('./background-processor');
const memoriesHandler = require('./background-handlers/memories');
const ActiveListener = require('./active-listener');

let messageQueueManager;
let backgroundProcessor;
let activeListener;

// Dedup: Baileys may fire messages.upsert with the same message more than once
const recentMessageIds = new Set();
const MESSAGE_DEDUP_TTL = 10000; // 10 seconds (longer than wwjs to handle offline bursts)

// --- Connection state ---
let sock = null;
let connectionStatus = 'waiting';
let lastQrDataUrl = null;
let lastQr = null;
let reconnectAttempts = 0;
let protocolFailures = 0; // consecutive protocol-level failures (not network issues)
const MAX_RECONNECT_DELAY = 60000;
const PROTOCOL_FAILURE_THRESHOLD = 3; // show red banner after this many consecutive protocol failures
let connectionOpenedAt = 0; // Unix ms — used for offline message detection
let connectionAlert = null; // { type: 'warning'|'error', message: string } shown in admin panel

// --- Baileys update helpers ---
let baileysUpdateInProgress = false;

async function checkAndUpdateBaileysIfNeeded() {
    // Parse outdated info from npm (exits with code 1 when outdated, so check both paths)
    let pkg = null;
    try {
        const { stdout } = await execAsync('npm outdated @whiskeysockets/baileys --json', {
            cwd: path.resolve(__dirname, '..'),
            timeout: 30000
        });
        if (stdout && stdout.trim()) {
            pkg = JSON.parse(stdout)['@whiskeysockets/baileys'];
        }
    } catch (e) {
        if (e.stdout && e.stdout.trim()) {
            try { pkg = JSON.parse(e.stdout)['@whiskeysockets/baileys']; } catch { /* ignore */ }
        }
        if (!e.stdout && !pkg) {
            logger.debug('Bot', `Baileys outdated check failed (non-critical): ${e.message}`);
            return;
        }
    }

    // npm outdated reports: current (installed), wanted (max satisfying semver range), latest (newest on registry)
    // We compare current vs wanted — latest may be a different major version we can't install via npm update
    if (!pkg || pkg.current === pkg.wanted) {
        // Check if a stable major version exists beyond our semver range (ignore pre-releases like rc/beta/alpha)
        const latestIsStable = pkg && pkg.latest && !pkg.latest.includes('-');
        if (latestIsStable && pkg.current !== pkg.latest && pkg.wanted !== pkg.latest) {
            logger.info('Bot', `Baileys is up to date (${pkg.current}), but a new major version is available: ${pkg.latest}`);
            logger.info('Bot', 'To upgrade, run: npm install @whiskeysockets/baileys@latest');
        } else {
            logger.info('Bot', 'Baileys is up to date');
        }
        return;
    }

    logger.warn('Bot', `Baileys update available: ${pkg.current} → ${pkg.wanted}. Installing in background...`);
    const updated = await updateBaileys();
    if (updated) {
        logger.warn('Bot', '');
        logger.warn('Bot', '========================================================');
        logger.warn('Bot', '  Baileys library was updated to the latest version.');
        logger.warn('Bot', '  Please restart the bot to apply the update:');
        logger.warn('Bot', '  Press Ctrl+C, then run "npm start"');
        logger.warn('Bot', '========================================================');
        logger.warn('Bot', '');
    }
}

async function updateBaileys() {
    if (baileysUpdateInProgress) return false;
    baileysUpdateInProgress = true;
    try {
        logger.info('Bot', 'Updating Baileys library...');
        const { stdout } = await execAsync('npm update @whiskeysockets/baileys 2>&1', {
            cwd: path.resolve(__dirname, '..'),
            timeout: 120000
        });
        if (stdout && stdout.trim()) {
            logger.info('Bot', `Baileys update result: ${stdout.trim()}`);
        }
        logger.info('Bot', 'Baileys updated successfully.');
        return true;
    } catch (e) {
        logger.error('Bot', `Baileys update failed: ${e.message}`);
        return false;
    } finally {
        baileysUpdateInProgress = false;
    }
}

async function checkBaileysLatest() {
    try {
        const { stdout } = await execAsync('npm outdated @whiskeysockets/baileys --json', {
            cwd: path.resolve(__dirname, '..'),
            timeout: 30000
        });
        if (stdout && stdout.trim()) return JSON.parse(stdout)['@whiskeysockets/baileys'] || null;
    } catch (e) {
        if (e.stdout && e.stdout.trim()) {
            try { return JSON.parse(e.stdout)['@whiskeysockets/baileys'] || null; } catch { /* ignore */ }
        }
    }
    return null;
}

// --- Offline "last_trigger" mode state ---
const offlineTriggerQueue = new Map(); // groupId -> { message, client, isBotMentioned, isReplyToBot, useActiveListening }
let offlineTriggerTimer = null;
const OFFLINE_TRIGGER_DEBOUNCE_MS = 3000;

// --- Shared state (persists across socket restarts) ---
let botInitialized = false;

// --- LID-to-phone mapping (populated from Baileys events) ---
const lidToPhone = new Map(); // LID JID → phone JID (e.g. "123@lid" → "456@s.whatsapp.net")

function registerLidMapping(lid, phoneJid) {
    if (lid && phoneJid && lid !== phoneJid) {
        lidToPhone.set(lid, phoneJid);
    }
}

/** Resolve a JID — if it's a LID, return the phone JID; otherwise return as-is */
function resolveLid(jid) {
    if (!jid) return jid;
    if (jid.endsWith('@lid') && lidToPhone.has(jid)) {
        return lidToPhone.get(jid);
    }
    return jid;
}

// --- Health check ---
let healthCheckInterval = null;
let lastMessageReceivedAt = Date.now();
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_STALE_THRESHOLD_MS = 300_000;

function updateLastMessageTime() {
    lastMessageReceivedAt = Date.now();
}

// =====================================================================
// Message Helpers (Baileys adapter)
// =====================================================================

function getMessageText(msg) {
    const m = msg.message;
    if (!m) return '';
    return m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || '';
}

function getMessageType(msg) {
    if (!msg.message) return 'unknown';
    return getContentType(msg.message);
}

function hasMedia(msg) {
    const type = getMessageType(msg);
    return ['imageMessage', 'audioMessage', 'pttMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(type);
}

function getQuotedInfo(msg) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.audioMessage?.contextInfo
        || msg.message?.pttMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo;

    if (!contextInfo?.quotedMessage) return null;

    return {
        quotedMessage: contextInfo.quotedMessage,
        quotedParticipant: contextInfo.participant,
        quotedMessageId: contextInfo.stanzaId,
        quotedBody: contextInfo.quotedMessage?.conversation
            || contextInfo.quotedMessage?.extendedTextMessage?.text
            || ''
    };
}

function getSafeContact(msg) {
    const rawSenderId = msg.key.participant || msg.key.remoteJid;
    // Prefer phone number from message key attributes, fall back to LID resolver
    const senderId = msg.key.participantPn || msg.key.senderPn || resolveLid(rawSenderId);
    const pushName = msg.pushName || 'Unknown User';
    return {
        id: { _serialized: jidToDbId(senderId) },
        pushname: pushName,
        name: pushName
    };
}

// Map Baileys message type to the simple type names the rest of the codebase expects
function simplifyType(baileysType) {
    const map = {
        'imageMessage': 'image',
        'audioMessage': 'audio',
        'pttMessage': 'ptt',
        'videoMessage': 'video',
        'documentMessage': 'document',
        'stickerMessage': 'sticker',
        'conversation': 'chat',
        'extendedTextMessage': 'chat',
    };
    return map[baileysType] || baileysType;
}

// =====================================================================
// Smart Authorization Check
// =====================================================================

async function checkAuth(_sockRef, userId, checkFn) {
    if (await checkFn(userId)) return true;

    // Try @c.us ↔ @s.whatsapp.net conversion
    const altId = userId.includes('@s.whatsapp.net')
        ? userId.replace('@s.whatsapp.net', '@c.us')
        : userId.replace('@c.us', '@s.whatsapp.net');
    if (await checkFn(altId)) return true;

    // LID fallback
    if (userId.endsWith('@lid')) {
        const number = userId.split('@')[0];
        const cUsId = `${number}@c.us`;
        if (await checkFn(cUsId)) return true;
    }

    return false;
}

async function checkIsAuthorized(sockRef, userId) {
    return checkAuth(sockRef, userId, isUserAuthorized);
}

async function checkIsAdmin(sockRef, userId) {
    return checkAuth(sockRef, userId, isUserAdmin);
}

// =====================================================================
// Bot Initialization (runs once)
// =====================================================================

async function initializeBot() {
    if (botInitialized) {
        logger.debug('Bot', 'initializeBot() already ran — skipping');
        return;
    }
    botInitialized = true;
    logger.info('Bot', 'Initializing bot...');
    await getDatabase();

    const imported = await importAuthFromFiles('authorized_numbers.txt', 'admin_numbers.txt');
    if (imported.authorized > 0 || imported.admin > 0) {
        logger.info('Bot', `Imported auth data from text files: ${imported.authorized} authorized, ${imported.admin} admins`);
    }

    const savedName = await getBotSetting('bot_name');
    const savedUserId = await getBotSetting('bot_user_id');
    const savedNumber = await getBotSetting('bot_number');
    if (savedName) config.botName = savedName;
    if (savedUserId) config.botUserId = savedUserId;
    if (savedNumber) config.botNumber = savedNumber;

    await conversationStore.initialize();
    messageQueueManager = new MessageQueueManager(config);
    await messageQueueManager.initialize();

    backgroundProcessor = new BackgroundProcessor(config);
    await backgroundProcessor.initialize();
    backgroundProcessor.registerHandler('memories', memoriesHandler);

    activeListener = new ActiveListener(config);
    await activeListener.initialize();
    activeListener.setInvocationHandler(handleBotInvocation);

    await fs.mkdir(config.imageDirectory, { recursive: true });
    await fs.mkdir(config.audioDirectory, { recursive: true });
    await fs.mkdir(config.memoriesDirectory, { recursive: true });

    if (config.botUserId) {
        addPhoneToUsernameMapping(config.botUserId, config.botName);
    }

    logger.info('Bot', 'Bot initialization complete');
}

// =====================================================================
// Client Adapter (wraps sock for downstream compatibility)
// =====================================================================

function createClientAdapter(sockRef) {
    return {
        sendMessage: async (chatId, content, options = {}) => {
            const jid = dbIdToJid(chatId);

            if (typeof content === 'string') {
                const payload = { text: content };
                if (options.mentions) {
                    payload.mentions = options.mentions.map(dbIdToJid);
                }
                return sockRef.sendMessage(jid, payload);
            }

            // Media message (content has _isMedia flag)
            if (content && content._isMedia) {
                const payload = {};
                if (options.sendAudioAsVoice) {
                    payload.audio = content.buffer;
                    payload.mimetype = 'audio/ogg; codecs=opus';
                    payload.ptt = true;
                } else if (content.mimetype?.startsWith('audio/')) {
                    payload.audio = content.buffer;
                    payload.mimetype = content.mimetype;
                } else if (content.mimetype?.startsWith('image/')) {
                    payload.image = content.buffer;
                    payload.mimetype = content.mimetype;
                } else {
                    payload.document = content.buffer;
                    payload.mimetype = content.mimetype;
                    payload.fileName = content.filename;
                }
                return sockRef.sendMessage(jid, payload);
            }
        },
        getChatById: async (id) => {
            const jid = dbIdToJid(id);
            if (isJidGroup(jid)) {
                try {
                    const metadata = await sockRef.groupMetadata(jid);
                    // Register LID→phone mappings from group metadata
                    for (const p of metadata.participants) {
                        if (p.lid && p.jid) registerLidMapping(p.lid, p.jid);
                        if (p.id && p.jid && p.id !== p.jid) registerLidMapping(p.id, p.jid);
                    }
                    return {
                        isGroup: true,
                        name: metadata.subject,
                        participants: metadata.participants.map(p => ({
                            id: { _serialized: jidToDbId(p.jid || p.id) },
                            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                            isSuperAdmin: p.admin === 'superadmin'
                        })),
                        description: metadata.desc || '',
                        sendStateTyping: async () => {
                            await sockRef.sendPresenceUpdate('composing', jid);
                        }
                    };
                } catch (e) {
                    return { isGroup: true, name: id, participants: [] };
                }
            }
            return {
                isGroup: false,
                name: id,
                sendStateTyping: async () => {
                    await sockRef.sendPresenceUpdate('composing', jid);
                }
            };
        },
        getContactById: async (id) => {
            const dbId = jidToDbId(id);
            return {
                id: { _serialized: dbId },
                pushname: dbId.split('@')[0],
                name: dbId.split('@')[0],
                number: dbId.split('@')[0]
            };
        },
        // Expose the raw sock for direct access when needed
        _sock: sockRef,
        // Compatibility with health.js status checks
        get info() {
            return {
                wid: { _serialized: config.botUserId, user: config.botNumber },
                pushname: config.botName
            };
        }
    };
}

// =====================================================================
// Message Adapter (wraps Baileys msg for downstream compatibility)
// =====================================================================

function createMessageAdapter(sockRef, msg) {
    const body = getMessageText(msg);
    const remoteJid = msg.key.remoteJid;
    const isGroup = isJidGroup(remoteJid);
    const rawParticipant = msg.key.participant || remoteJid;
    const resolvedParticipant = msg.key.participantPn || msg.key.senderPn || resolveLid(rawParticipant);
    const senderId = jidToDbId(resolvedParticipant);
    const msgId = msg.key.id;
    const baileysType = getMessageType(msg);

    return {
        id: { _serialized: msgId },
        from: jidToDbId(remoteJid),
        author: isGroup ? senderId : undefined,
        body: body,
        fromMe: msg.key.fromMe,
        timestamp: Number(msg.messageTimestamp),
        hasMedia: hasMedia(msg),
        type: simplifyType(baileysType),
        mentionedIds: msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.map(j => jidToDbId(resolveLid(j))) || [],
        hasQuotedMsg: !!getQuotedInfo(msg),
        _data: { notifyName: msg.pushName || 'Unknown User' },
        duration: msg.message?.audioMessage?.seconds || msg.message?.pttMessage?.seconds || 0,
        _rawMsg: msg,

        getChat: async () => {
            if (isGroup) {
                try {
                    const metadata = await sockRef.groupMetadata(remoteJid);
                    // Register LID→phone mappings from group metadata
                    for (const p of metadata.participants) {
                        if (p.lid && p.jid) registerLidMapping(p.lid, p.jid);
                        if (p.id && p.jid && p.id !== p.jid) registerLidMapping(p.id, p.jid);
                    }
                    return {
                        isGroup: true,
                        name: metadata.subject,
                        participants: metadata.participants.map(p => ({
                            id: { _serialized: jidToDbId(p.jid || p.id) },
                            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                            isSuperAdmin: p.admin === 'superadmin'
                        })),
                        description: metadata.desc || '',
                        createdAt: metadata.creation,
                        sendStateTyping: async () => {
                            await sockRef.sendPresenceUpdate('composing', remoteJid);
                        }
                    };
                } catch (e) {
                    return { isGroup: true, name: remoteJid, participants: [], sendStateTyping: async () => { } };
                }
            }
            return {
                isGroup: false,
                name: msg.pushName || remoteJid,
                participants: [],
                sendStateTyping: async () => {
                    await sockRef.sendPresenceUpdate('composing', remoteJid);
                }
            };
        },

        getQuotedMessage: async () => {
            const info = getQuotedInfo(msg);
            if (!info) return null;
            return {
                body: info.quotedBody,
                author: jidToDbId(resolveLid(info.quotedParticipant)),
                from: jidToDbId(remoteJid),
                id: { _serialized: info.quotedMessageId },
                hasMedia: !!info.quotedMessage?.imageMessage || !!info.quotedMessage?.audioMessage,
                type: info.quotedMessage?.imageMessage ? 'image' : (info.quotedMessage?.audioMessage ? 'audio' : 'chat'),
                _rawQuotedMsg: info.quotedMessage,
                downloadMedia: async () => {
                    try {
                        const buffer = await downloadMediaMessage(
                            { message: info.quotedMessage, key: { id: info.quotedMessageId, remoteJid, fromMe: false } },
                            'buffer',
                            {}
                        );
                        let type = 'imageMessage';
                        if (info.quotedMessage?.audioMessage) type = 'audioMessage';
                        if (info.quotedMessage?.videoMessage) type = 'videoMessage';
                        if (info.quotedMessage?.documentMessage) type = 'documentMessage';
                        if (info.quotedMessage?.stickerMessage) type = 'stickerMessage';

                        const mediaMsg = info.quotedMessage[type];
                        return {
                            data: buffer.toString('base64'),
                            mimetype: mediaMsg?.mimetype || 'application/octet-stream',
                            filename: mediaMsg?.fileName || null,
                            filesize: buffer.length
                        };
                    } catch (e) {
                        logger.error('Media', `Quoted media download failed: ${e.message}`);
                        return null;
                    }
                }
            };
        },

        downloadMedia: async () => {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const mediaMsg = msg.message[baileysType];
                return {
                    data: buffer.toString('base64'),
                    mimetype: mediaMsg?.mimetype || 'application/octet-stream',
                    filename: mediaMsg?.fileName || null,
                    filesize: buffer.length
                };
            } catch (e) {
                logger.error('Media', `Download failed: ${e.message}`);
                return null;
            }
        }
    };
}

// =====================================================================
// Message Handler
// =====================================================================

async function handleIncomingMessage(sockRef, msg) {
    // Ignore bot's own messages
    if (msg.key.fromMe) return;

    // Ignore status/broadcast
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (!msg.message) return;

    // Ignore protocol messages (reactions, receipts, etc.)
    const contentType = getContentType(msg.message);
    if (contentType === 'protocolMessage' || contentType === 'reactionMessage' || contentType === 'senderKeyDistributionMessage') return;

    // Dedup
    const msgId = msg.key.id;
    if (recentMessageIds.has(msgId)) return;
    recentMessageIds.add(msgId);
    setTimeout(() => recentMessageIds.delete(msgId), MESSAGE_DEDUP_TTL);

    updateLastMessageTime();

    // Create adapter objects
    const client = createClientAdapter(sockRef);
    const message = createMessageAdapter(sockRef, msg);

    logger.info('Message', `Received message: ${message.body}`);
    const chat = await message.getChat();
    logger.debug('Message', `Is group message: ${chat.isGroup}`);

    const contact = getSafeContact(msg);
    logger.debug('Message', `Sender: ${contact.id._serialized}`);

    // Sync user data
    const senderId = contact.id._serialized;
    const profileName = contact.pushname || contact.name || 'Unknown User';
    try {
        await upsertUser(senderId, profileName);
    } catch (error) {
        logger.error('Message', 'Error syncing user data: ' + error.message);
    }

    // Passive auto-registration: ensure group/DM is in DB
    try {
        const chatName = chat.isGroup
            ? (chat.name || 'Group Chat')
            : (chat.name || contact.pushname || contact.name || 'Direct Message');
        const regInfo = await getOrCreateGroupInfo(message.from, chatName);
        if (chatName !== message.from && regInfo.group_name === regInfo.group_id) {
            await updateGroupInfo(message.from, { group_name: chatName });
        }
    } catch (error) {
        logger.error('Message', 'Error auto-registering chat: ' + error.message);
    }

    // For DMs, attach the contact name
    if (!chat.isGroup) {
        message.dmContactName = chat.name || contact.pushname || contact.name || 'Direct Message';
    }

    // Process and store all messages
    try {
        await processAndStoreMessage(client, message);
    } catch (storeError) {
        logger.error('Store', 'Failed to store message, continuing with bot logic: ' + storeError.message);
    }

    // Feed message to background processor (groups only)
    if (chat.isGroup && backgroundProcessor) {
        try {
            backgroundProcessor.feedMessage(message.from);
        } catch (bgErr) {
            logger.error('Background', 'Error feeding message: ' + bgErr.message);
        }
    }

    // --- Offline message detection ---
    const msgTimestampMs = message.timestamp * 1000;
    if (connectionOpenedAt > 0 && msgTimestampMs < connectionOpenedAt) {
        const offlineMode = await getBotSetting('offline_message_mode') || 'last_trigger';
        if (offlineMode === 'store_only') {
            logger.info('Offline', `Stored offline message from ${senderId} in ${message.from} (sent ${new Date(msgTimestampMs).toISOString()}, connected ${new Date(connectionOpenedAt).toISOString()}) — skipping AI`);
            return;
        }

        if (offlineMode === 'last_trigger' && chat.isGroup) {
            // Detect mention/reply early for offline trigger tracking
            const mentionedIds = message.mentionedIds || [];
            const isBotMentioned = mentionedIds.includes(config.botUserId)
                || message.body.includes(`@${config.botName}`)
                || message.body.includes(`@${config.botNumber}`);
            const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;
            const quotedAuthor = quotedMessage ? (quotedMessage.author || quotedMessage.from) : null;
            const isReplyToBot = quotedAuthor ? (quotedAuthor === config.botUserId) : false;

            const groupInfo = await getOrCreateGroupInfo(message.from, chat.name || 'Group Chat');
            const useActiveListening = groupInfo.active_listening_enabled === 1;

            const isTrigger = useActiveListening || isBotMentioned || isReplyToBot;

            if (isTrigger && groupInfo.is_active) {
                offlineTriggerQueue.set(message.from, {
                    message, client, isBotMentioned, isReplyToBot, useActiveListening
                });
                logger.info('Offline', `Tracked last trigger from ${senderId} in ${message.from} (active_listening=${useActiveListening}, mention=${isBotMentioned}, reply=${isReplyToBot})`);
            }

            // Reset debounce timer — process after burst settles
            if (offlineTriggerTimer) clearTimeout(offlineTriggerTimer);
            offlineTriggerTimer = setTimeout(() => {
                offlineTriggerTimer = null;
                processOfflineTriggers();
            }, OFFLINE_TRIGGER_DEBOUNCE_MS);

            return;
        }
        // Future: 'queue_all' mode would be handled here
    }

    // Mention/reply detection
    const mentionedIds = message.mentionedIds || [];
    const isBotMentioned = mentionedIds.includes(config.botUserId)
        || message.body.includes(`@${config.botName}`)
        || message.body.includes(`@${config.botNumber}`);
    logger.debug('Message', `Mention check: mentionedIds=${JSON.stringify(mentionedIds)}, botUserId=${config.botUserId}, isBotMentioned=${isBotMentioned}`);

    const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;
    const quotedAuthor = quotedMessage ? (quotedMessage.author || quotedMessage.from) : null;
    const isReplyToBot = quotedAuthor ? (quotedAuthor === config.botUserId) : false;

    if (quotedMessage) {
        logger.debug('Message', `Reply check: quotedAuthor=${quotedAuthor}, botUserId=${config.botUserId}, isReplyToBot=${isReplyToBot}`);
    }

    // Command dispatch
    const commandMatch = message.body.match(/!(\w+)/);
    const hasCommand = commandMatch !== null;

    if (hasCommand) {
        const fullCommand = commandMatch[0];
        const commandName = commandMatch[1].toLowerCase();

        // Authorization check — public commands skip entirely, non-admin commands require authorized, rest require admin
        const { commands: registeredCommands } = require('./commands/index');
        const cmdEntry = registeredCommands.get(`!${commandName}`);

        if (cmdEntry && !cmdEntry.public) {
            const isAuthorized = await checkIsAuthorized(sockRef, senderId);
            const isAdmin = await checkIsAdmin(sockRef, senderId);

            if (!cmdEntry.adminOnly) {
                if (!isAuthorized && !isAdmin) {
                    await client.sendMessage(message.from, `Sorry ${contact.pushname}, you are not authorized to use this command.`);
                    return;
                }
            } else {
                if (!isAdmin) {
                    logger.warn('Auth', `Unauthorized user ${senderId} (${contact.pushname}) attempted to use an admin command`);
                    await client.sendMessage(message.from, `Sorry ${contact.pushname}, only admins can use bot commands.`);
                    return;
                }
            }
        }

        await dispatch(`!${commandName}`, client, message, {
            ...config,
            messageQueueManager
        });

    } else if (chat.isGroup) {
        const groupInfo = await getOrCreateGroupInfo(message.from, chat.name || 'Group Chat');

        if (chat.name && groupInfo.group_name === groupInfo.group_id) {
            await updateGroupInfo(message.from, { group_name: chat.name });
        }

        if (!groupInfo.is_active) {
            logger.debug('Message', `Skipping AI for inactive group ${message.from}`);
            return;
        }

        // Global bot active check (prevents active listener LLM calls too)
        const globalBotActive = await getBotSetting('bot_active');
        if (globalBotActive === '0') {
            logger.debug('Message', 'Bot is globally disabled — skipping AI');
            return;
        }

        const useActiveListening = groupInfo.active_listening_enabled === 1;

        if (useActiveListening) {
            if (activeListener) {
                try {
                    activeListener.feedMessage(message.from, message, client, { isBotMentioned, isReplyToBot });
                } catch (alErr) {
                    logger.error('ActiveListener', 'Error feeding message: ' + alErr.message);
                }
            }
        } else if (isBotMentioned || isReplyToBot) {
            const authCheckEnabled = groupInfo.authorization_check_enabled !== 0;

            if (!authCheckEnabled) {
                await handleBotInvocation(client, message);
            } else {
                const isAuthorized = await checkIsAuthorized(sockRef, contact.id._serialized);
                const isAdmin = await checkIsAdmin(sockRef, contact.id._serialized);

                if (isAuthorized || isAdmin) {
                    await handleBotInvocation(client, message);
                } else {
                    logger.warn('Auth', `Unauthorized user ${contact.id._serialized} (${contact.pushname}) attempted to invoke bot`);
                }
            }
        }

    } else if (!chat.isGroup) {
        // 1-1 chat: allow admins to chat directly with the bot
        const isAdmin = await checkIsAdmin(sockRef, contact.id._serialized);
        const globalBotActiveDm = await getBotSetting('bot_active');
        if (globalBotActiveDm === '0') {
            if (isAdmin) {
                await client.sendMessage(message.from, `Hey! I'm currently offline. You can re-enable me from the admin panel or by sending *!start* in a group.`);
            }
            return;
        }
        if (isAdmin) {
            await handleBotInvocation(client, message);
        } else {
            const isAuthorized = await checkIsAuthorized(sockRef, contact.id._serialized);
            if (isAuthorized) {
                await client.sendMessage(message.from, `Hey! DMs are only available for admins. You can talk to me in any group where I'm active.`);
            }
        }
    }
}

// =====================================================================
// Process & Store Message
// =====================================================================

async function processAndStoreMessage(client, message) {
    let imageId = null;
    let messageText = message.body || 'Sent a message';

    if (message.hasMedia && message.type === 'image') {
        imageId = await processAndStoreImage(client, message);
        message.imageId = imageId;
        messageText = `Sent image id: ${imageId}`;
    }

    let audioId = null;
    if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        const groupInfo = await getOrCreateGroupInfo(message.from, message.groupInfo?.name || message.dmContactName || 'Unknown Group');
        const durationCap = groupInfo.audio_duration_cap;
        const audioDuration = message.duration || 0;

        if (durationCap && durationCap > 0 && audioDuration > durationCap) {
            logger.info('Audio', `Audio message ${message.id._serialized} exceeds duration cap (${audioDuration}s > ${durationCap}s)`);
            messageText = `Sent an audio message (${audioDuration}s) that exceeded the duration cap (${durationCap}s)`;
            message.audioDurationExceeded = true;
        } else {
            audioId = await processAndStoreAudio(client, message);
            message.audioId = audioId;
            messageText = `Sent audio id: ${audioId}`;
        }
    }

    const contact = {
        id: { _serialized: message.author || message.from },
        pushname: message._data.notifyName,
        name: message._data.notifyName
    };
    const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;

    const newMessage = {
        sender: contact.pushname || contact.name || 'Unknown User',
        senderId: contact.id._serialized,
        message: messageText,
        timestamp: new Date(message.timestamp * 1000).toISOString(),
        quotedMsg: quotedMessage ? quotedMessage.body : null,
        imageId: imageId,
        audioId: audioId,
        quotedParticipant: quotedMessage ? (quotedMessage.author || quotedMessage.from) : null,
        whatsappMessageId: message.id._serialized,
        quotedWhatsappMessageId: quotedMessage ? quotedMessage.id._serialized : null
    };

    await conversationStore.addMessageToConversation(message.from, newMessage);
    addPhoneToUsernameMapping(contact.id._serialized, contact.pushname || contact.name || 'Unknown User');
}

// =====================================================================
// Media Processing (simplified — no pupPage fallback needed)
// =====================================================================

async function processAndStoreImage(_client, message) {
    const msgId = message.id._serialized;
    try {
        logger.info('Image', `Downloading media for message ${msgId}...`);
        const media = await message.downloadMedia();

        if (!media || !media.data) {
            logger.warn('Image', `Download failed for ${msgId}`);
            return null;
        }

        const imageBuffer = Buffer.from(media.data, 'base64');
        const imageId = `img_${Date.now()}`;
        const imagePath = path.join(config.imageDirectory, `${imageId}.jpg`);
        await fs.writeFile(imagePath, imageBuffer);
        logger.info('Image', `Stored image: ${imagePath} (${imageBuffer.length} bytes)`);
        return imageId;
    } catch (error) {
        logger.error('Image', `Error storing image for ${msgId}: ${error.message}`);
        return null;
    }
}

async function processAndStoreAudio(_client, message) {
    const msgId = message.id._serialized;
    try {
        logger.info('Audio', `Downloading media for message ${msgId}...`);
        const media = await message.downloadMedia();

        if (!media || !media.data) {
            logger.warn('Audio', `Download failed for ${msgId}`);
            return null;
        }

        const extension = media.mimetype.split('/')[1].split(';')[0] || 'ogg';
        const audioBuffer = Buffer.from(media.data, 'base64');
        const audioId = `audio_${Date.now()}`;
        const audioPath = path.join(config.audioDirectory, `${audioId}.${extension}`);
        await fs.writeFile(audioPath, audioBuffer);
        logger.info('Audio', `Stored audio: ${audioPath} (${audioBuffer.length} bytes)`);
        return audioId;
    } catch (error) {
        logger.error('Audio', `Error storing audio for ${msgId}: ${error.message}`);
        return null;
    }
}

// =====================================================================
// Bot Invocation Handler
// =====================================================================

async function handleBotInvocation(client, message) {
    // Global bot active check
    const botActive = await getBotSetting('bot_active');
    if (botActive === '0') {
        logger.debug('Message', 'Bot is globally disabled — skipping AI response');
        return;
    }

    if (message.audioDurationExceeded) {
        const groupInfo = await getOrCreateGroupInfo(message.from, 'Unknown Group');
        const cap = groupInfo.audio_duration_cap || 900;
        const capMinutes = Math.floor(cap / 60);
        const capLabel = capMinutes >= 1 ? `${capMinutes} minute${capMinutes !== 1 ? 's' : ''}` : `${cap} seconds`;
        await client.sendMessage(message.from, `Sorry, I couldn't process that audio because it's too long. The maximum duration is ${capLabel}.`);
        return;
    }

    const useExtendedHistory = message.body.includes(config.extendedHistoryCode);
    let historyLimit = useExtendedHistory ? config.extendedMessageHistoryLimit : config.messageHistoryLimit;

    try {
        const groupInfo = await getOrCreateGroupInfo(message.from, 'Unknown Group');
        if (!useExtendedHistory) {
            if (groupInfo.custom_message_limit) {
                historyLimit = groupInfo.custom_message_limit;
            } else {
                const globalDefault = await getBotSetting('default_message_history_limit');
                if (globalDefault) {
                    historyLimit = parseInt(globalDefault);
                }
            }
        }
    } catch (error) {
        logger.error('Message', 'Error loading message history limit: ' + error.message);
    }

    if (messageQueueManager) {
        await messageQueueManager.queueMessage(client, message, historyLimit);
    } else {
        logger.error('Message', 'MessageQueueManager is not initialized');
        await client.sendMessage(message.from, 'Sorry, there was an error processing your request. Please try again later.');
    }
}

// =====================================================================
// Offline "Last Trigger" Processing
// =====================================================================

function processOfflineTriggers() {
    for (const [groupId, entry] of offlineTriggerQueue) {
        logger.info('Offline', `Processing last trigger for group ${groupId}`);
        try {
            if (entry.useActiveListening && activeListener) {
                activeListener.feedMessage(groupId, entry.message, entry.client, {
                    isBotMentioned: entry.isBotMentioned,
                    isReplyToBot: entry.isReplyToBot
                });
            } else {
                handleBotInvocation(entry.client, entry.message);
            }
        } catch (err) {
            logger.error('Offline', `Error processing offline trigger for ${groupId}: ${err.message}`);
        }
    }
    offlineTriggerQueue.clear();
}

// =====================================================================
// Health Check (simplified for Baileys)
// =====================================================================

function startHealthCheck() {
    if (healthCheckInterval) return;
    healthCheckInterval = setInterval(async () => {
        if (connectionStatus !== 'ready') return;
        const silentMs = Date.now() - lastMessageReceivedAt;
        if (silentMs > HEALTH_CHECK_STALE_THRESHOLD_MS) {
            try {
                await sock.sendPresenceUpdate('available');
                logger.debug('HealthCheck', `Presence ping sent (${Math.round(silentMs / 1000)}s since last message)`);
            } catch (e) {
                logger.warn('HealthCheck', `Presence ping failed: ${e.message}`);
            }
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

// =====================================================================
// Socket Creation & Connection
// =====================================================================

let baileysOutdatedChecked = false; // only check once per process lifetime
let isStartingSocket = false; // guard against concurrent startSocket() calls

async function startSocket() {
    // Prevent concurrent socket creation (causes 440 "connectionReplaced" loops)
    if (isStartingSocket) {
        logger.debug('Bot', 'startSocket() already in progress, skipping duplicate call');
        return;
    }
    isStartingSocket = true;

    try {
        // Clean up previous socket before creating a new one
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
            } catch (_) { /* ignore cleanup errors */ }
            sock = null;
        }

        await _startSocketInternal();
    } finally {
        isStartingSocket = false;
    }
}

async function _startSocketInternal() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authSessionPath);

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
        logger.info('Bot', `Using WA version: ${version.join('.')}`);
    } catch (e) {
        logger.warn('Bot', `Could not fetch latest version, using default: ${e.message}`);
    }

    sock = makeWASocket({
        auth: state,
        ...(version && { version }),
        logger: pino({ level: 'silent' }),
        browser: ['Chrome', 'Chrome', '130.0.0'],
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        getMessage: async () => {
            // Required for retries — return message from DB if available
            return undefined;
        }
    });

    // Save credentials when they update
    sock.ev.on('creds.update', saveCreds);

    // Connection state changes
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            lastQr = qr;
            try {
                lastQrDataUrl = await QRCode.toDataURL(qr);
            } catch (e) { /* ignore */ }
            connectionStatus = 'qr';
            logger.info('Bot', '='.repeat(50));
            logger.info('Bot', 'QR CODE READY — Scan with WhatsApp');
            logger.info('Bot', '='.repeat(50));
        }

        if (connection === 'connecting') {
            connectionStatus = 'loading';
            logger.info('Bot', 'Connecting to WhatsApp...');
        }

        if (connection === 'open') {
            lastQr = null;
            lastQrDataUrl = null;
            connectionStatus = 'ready';
            reconnectAttempts = 0;
            protocolFailures = 0;
            connectionAlert = null; // clear any previous alert on successful connection
            connectionOpenedAt = Date.now();

            // Check for Baileys updates in background (non-blocking, once per process)
            if (!baileysOutdatedChecked) {
                baileysOutdatedChecked = true;
                checkAndUpdateBaileysIfNeeded().catch(() => {});
            }

            logger.info('Bot', 'Connected to WhatsApp!');

            try {
                await initializeBot();

                // Auto-detect bot identity
                if (sock.user) {
                    // Prefer phone JID over LID for bot identity
                    const rawId = sock.user.jid || sock.user.id;
                    const normalizedId = jidNormalizedUser(rawId);
                    const detectedNumber = normalizedId.split('@')[0];
                    const detectedPushname = sock.user.name || '';
                    const detectedUserId = jidToDbId(normalizedId);

                    // Register LID→phone mapping for the bot itself
                    if (sock.user.lid) {
                        registerLidMapping(sock.user.lid, normalizedId);
                        logger.info('Bot', `Registered bot LID mapping: ${sock.user.lid} → ${normalizedId}`);
                    }
                    if (sock.user.id !== normalizedId) {
                        registerLidMapping(sock.user.id, normalizedId);
                    }

                    await setBotSetting('bot_user_id', detectedUserId);
                    await setBotSetting('bot_number', detectedNumber);
                    await setBotSetting('bot_pushname', detectedPushname);

                    const existingName = await getBotSetting('bot_name');
                    if (!existingName) {
                        await setBotSetting('bot_name', detectedPushname || config.botName);
                    }

                    config.botUserId = detectedUserId;
                    config.botNumber = detectedNumber;
                    config.botName = (await getBotSetting('bot_name')) || config.botName;

                    addPhoneToUsernameMapping(config.botUserId, config.botName);
                    logger.info('Bot', `Bot identity: ${config.botName} (${detectedNumber}, ${detectedUserId})`);
                }

                // Set presence available
                try {
                    await sock.sendPresenceUpdate('available');
                } catch (e) {
                    logger.warn('Bot', 'Could not set presence available: ' + e.message);
                }

                lastMessageReceivedAt = Date.now();
                startHealthCheck();

                logger.info('Bot', 'Bot successfully started and ready to receive messages!');
            } catch (error) {
                logger.error('Bot', `Error during bot initialization: ${error.message}`);
                logger.error('Bot', error.stack);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || '';
            lastQr = null;
            lastQrDataUrl = null;

            if (healthCheckInterval) {
                clearInterval(healthCheckInterval);
                healthCheckInterval = null;
            }

            // Protocol-level errors that suggest Baileys/bot code needs updating
            // These are NOT network issues — Meta changed something server-side
            const isProtocolError = [410, 411, 428, 500, 501, 502, 503].includes(statusCode);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                connectionStatus = 'disconnected';
                logger.warn('Bot', `Session invalid (code=${statusCode}). Clearing auth session for re-authentication...`);
                try {
                    await fs.rm(config.authSessionPath, { recursive: true, force: true });
                } catch (e) {
                    logger.error('Bot', `Failed to delete auth session: ${e.message}`);
                }
                reconnectAttempts = 0;
                protocolFailures = 0;
                setTimeout(() => startSocket(), 2000);
            } else if (isProtocolError) {
                protocolFailures++;
                reconnectAttempts++;
                logger.warn('Bot', `Protocol error (code=${statusCode}, msg="${errorMessage}"). Protocol failure #${protocolFailures}`);

                if (protocolFailures >= PROTOCOL_FAILURE_THRESHOLD) {
                    logger.error('Bot', `Protocol failures exceeded threshold (${protocolFailures}). Attempting auto-update...`);

                    // Try updating within semver range first, then check if a major version exists
                    updateBaileys().then(async (updated) => {
                        // Check if there's a newer major version beyond our semver range
                        const pkg = await checkBaileysLatest();
                        const latestIsStable = pkg && pkg.latest && !pkg.latest.includes('-');
                        const hasMajorUpdate = latestIsStable && pkg.current !== pkg.latest && pkg.wanted !== pkg.latest;

                        if (updated && !hasMajorUpdate) {
                            // Minor/patch update was installed
                            connectionAlert = {
                                type: 'warning',
                                message: `WhatsApp library was auto-updated after repeated protocol errors (${statusCode}). Please restart the bot (Ctrl+C then "npm start") to apply the update.`
                            };
                            logger.warn('Bot', '');
                            logger.warn('Bot', '========================================================');
                            logger.warn('Bot', '  Baileys was auto-updated due to protocol errors.');
                            logger.warn('Bot', '  Please restart the bot to apply the update:');
                            logger.warn('Bot', '  Press Ctrl+C, then run "npm start"');
                            logger.warn('Bot', '========================================================');
                            logger.warn('Bot', '');
                        } else if (hasMajorUpdate) {
                            // Major version available — user needs to upgrade manually
                            connectionAlert = {
                                type: 'error',
                                message: `WhatsApp connection is failing (error ${statusCode}). `
                                    + `A new major version of the WhatsApp library is available (${pkg.current} → ${pkg.latest}). `
                                    + 'Run "git pull && npm install" in the bot folder and restart.'
                            };
                            logger.error('Bot', '');
                            logger.error('Bot', '========================================================');
                            logger.error('Bot', `  Baileys major update available: ${pkg.current} → ${pkg.latest}`);
                            logger.error('Bot', '  This likely fixes the protocol errors.');
                            logger.error('Bot', '  To upgrade, run:');
                            logger.error('Bot', '    git pull && npm install');
                            logger.error('Bot', '  Then restart with "npm start"');
                            logger.error('Bot', '========================================================');
                            logger.error('Bot', '');
                        } else {
                            connectionAlert = {
                                type: 'error',
                                message: `WhatsApp connection is failing repeatedly (error ${statusCode}). `
                                    + 'Auto-update found no new version. Try running "git pull && npm install" in the bot folder and restarting.'
                            };
                        }

                        // Keep retrying regardless
                        connectionStatus = 'reconnecting';
                        setTimeout(() => startSocket(), MAX_RECONNECT_DELAY);
                    });
                    return;
                }

                // Below threshold — keep retrying with backoff
                connectionStatus = 'reconnecting';
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
                logger.info('Bot', `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
                setTimeout(() => startSocket(), delay);
            } else {
                // Recoverable errors (network issues, temporary server problems, etc.)
                // Reset protocol failure counter since this is a different kind of error
                protocolFailures = 0;
                connectionStatus = 'reconnecting';
                reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
                logger.info('Bot', `Disconnected (code=${statusCode}). Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
                setTimeout(() => startSocket(), delay);
            }
        }
    });

    // LID-to-phone mapping from contacts
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.jid) registerLidMapping(c.lid, c.jid);
            if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) registerLidMapping(c.lid, c.id);
            if (c.id?.endsWith('@lid') && c.jid) registerLidMapping(c.id, c.jid);
        }
        logger.debug('Bot', `LID map updated from contacts.upsert (${lidToPhone.size} entries)`);
    });

    sock.ev.on('contacts.update', (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.jid) registerLidMapping(c.lid, c.jid);
            if (c.id?.endsWith('@lid') && c.jid) registerLidMapping(c.id, c.jid);
        }
    });

    // Direct phone number sharing event
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        registerLidMapping(lid, jid);
        logger.debug('Bot', `Phone number shared: ${lid} → ${jid}`);
    });

    // Extract LID mappings from message keys
    sock.ev.on('messages.upsert', ({ messages: msgs }) => {
        for (const msg of msgs) {
            const key = msg.key;
            if (key.participantLid && key.participantPn) {
                registerLidMapping(key.participantLid, key.participantPn);
            }
            if (key.senderLid && key.senderPn) {
                registerLidMapping(key.senderLid, key.senderPn);
            }
        }
    });

    // Message handler
    // 'notify' = real-time messages, 'append' = offline catch-up messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            try {
                await handleIncomingMessage(sock, msg);
            } catch (err) {
                logger.error('Message', `Unhandled error in message handler: ${err.message}`);
                logger.error('Message', err.stack);
            }
        }
    });
}

// =====================================================================
// Unhandled Rejection Handler
// =====================================================================

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Bot', 'Unhandled Rejection at: ' + promise);
    logger.error('Bot', 'Reason: ' + (reason instanceof Error ? reason.stack : JSON.stringify(reason)));
});

// =====================================================================
// Start Admin Panel & Socket
// =====================================================================

(async () => {
    try {
        await getDatabase();
        const { startAdminServer } = require('./admin/admin-server');
        await startAdminServer(config, {
            get whatsappClient() {
                return sock ? createClientAdapter(sock) : null;
            },
            get messageQueueManager() { return messageQueueManager; },
            resolveLid
        });
    } catch (err) {
        logger.error('Admin', 'Error starting admin panel: ' + err.message);
    }
})();

// Only auto-start WhatsApp if setup is complete; otherwise wait for the setup wizard
(async () => {
    try {
        const setupComplete = await getBotSetting('setup_complete');
        if (setupComplete === '1' && process.env.GEMINI_API_KEY) {
            logger.info('Bot', 'Starting Baileys WhatsApp client...');
            startSocket();
        } else {
            logger.info('Bot', 'Setup not complete — waiting for setup wizard at http://localhost:' + config.adminPort);
        }
    } catch (err) {
        logger.error('Bot', 'Error checking setup state: ' + err.message);
        // Fall back to starting if we can't check
        if (process.env.GEMINI_API_KEY) startSocket();
    }
})();

// Graceful shutdown
let isShuttingDown = false;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Bot', `Shutting down (${signal})...`);
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    if (backgroundProcessor) backgroundProcessor.destroy();
    if (activeListener) activeListener.destroy();
    try { sock?.end(undefined); } catch (_) { /* ignore */ }
    // Flush pending token usage writes before closing the database
    const trackers = [
        messageQueueManager?.tokenUsageTracker,
        backgroundProcessor?.tokenUsageTracker,
        activeListener?.tokenUsageTracker,
    ];
    for (const tracker of trackers) {
        try { if (tracker) await tracker.forceCommit(); } catch (_) { /* ignore */ }
    }
    await closeDatabase();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Export for connection.js and other modules
module.exports = {
    initializeBot,
    getConnectionState: () => ({
        status: connectionStatus,
        lastQr,
        lastQrDataUrl,
        sock,
        alert: connectionAlert,
        get info() {
            return sock?.user ? {
                pushname: sock.user.name || config.botName,
                phone: extractNumber(sock.user.id)
            } : null;
        }
    }),
    startSocket,
    getSock: () => sock,
    resolveLid,
};
