# Migration Guide: whatsapp-web.js → Baileys

This document is a self-contained reference for migrating wispbot from `whatsapp-web.js` (Puppeteer-based) to `@whiskeysockets/baileys` (direct WebSocket). It contains every detail needed to implement the migration without referring to the original session.

## Table of Contents

1. [Motivation](#1-motivation)
2. [Architecture Difference](#2-architecture-difference)
3. [Dependency Changes](#3-dependency-changes)
4. [File-by-File Migration Map](#4-file-by-file-migration-map)
5. [Data Structure Translation](#5-data-structure-translation)
6. [src/bot.js — Full Rewrite](#6-srcbotjs--full-rewrite)
7. [src/message-queue.js — Partial Rewrite](#7-srcmessage-queuejs--partial-rewrite)
8. [src/admin/routes/connection.js — Full Rewrite](#8-srcadminroutesconnectionjs--full-rewrite)
9. [Other Admin Routes (groups.js, users.js, health.js)](#9-other-admin-routes-groupsjs-usersjs-healthjs)
10. [src/services/auth.js — Update](#10-srcservicesauthjs--update)
11. [src/active-listener.js — Minor Update](#11-srcactive-listenerjs--minor-update)
12. [Command Files — Pattern Update](#12-command-files--pattern-update)
13. [Offline Message Handling](#13-offline-message-handling)
14. [Session & Authentication](#14-session--authentication)
15. [Health Check & Recovery](#15-health-check--recovery)
16. [QR Code for Admin Panel](#16-qr-code-for-admin-panel)
17. [Testing Checklist](#17-testing-checklist)

---

## 1. Motivation

- **Offline messages**: whatsapp-web.js only fires events for messages with `isNewMsg=true`. Messages received while the bot is offline are synced into the WhatsApp Web UI but never trigger the `'message'` event. Baileys fires `messages.upsert` with `type: 'notify'` for these messages on reconnect.
- **No Chrome dependency**: Baileys connects via WebSocket directly — no Puppeteer, no Chrome, less memory, faster startup.
- **Simpler recovery**: No 3-step browser recovery needed. Just reconnect the socket.
- **Lower resource usage**: No headless browser process.

---

## 2. Architecture Difference

### whatsapp-web.js (current)
```
Node.js → Puppeteer → Chrome → WhatsApp Web (browser) → WhatsApp servers
```
- Requires Chrome installed on server
- Session stored in `./tokens/session-sessionName/` (Chrome profile data)
- Message events come from injected JS in browser context (`window.Store.Msg.on('add')`)
- Recovery involves page reloads, browser restarts, killing zombie Chrome processes

### Baileys (target)
```
Node.js → WebSocket → WhatsApp servers
```
- No browser needed
- Session stored as JSON files (creds.json + keys)
- Message events come directly from the WebSocket protocol
- Recovery = reconnect socket

---

## 3. Dependency Changes

### package.json changes

**Remove:**
```json
"whatsapp-web.js": "github:pedroslopez/whatsapp-web.js#main"
```

**Remove overrides section entirely:**
```json
"overrides": {
    "puppeteer": "23.6.0",
    "puppeteer-core": "23.6.0"
}
```

**Add:**
```json
"@whiskeysockets/baileys": "^6.7.16",
"pino": "^9.0.0"
```

**Remove (no longer needed):**
```json
"@puppeteer/browsers": "^2.4.0",
"qrcode-terminal": "^0.12.0"
```

**Add (for QR code in admin panel — qrcode-terminal can be kept for CLI, but for admin panel you'll want the `qrcode` library to generate a data URL):**
```json
"qrcode": "^1.5.4"
```

> Note: `qrcode-terminal` can remain if you still want CLI QR output. `qrcode` is for generating QR as base64 data URL for the admin panel.

---

## 4. File-by-File Migration Map

| File | Effort | What Changes |
|------|--------|-------------|
| `src/bot.js` | **Full rewrite** | Client lifecycle, events, health checks, recovery, message handler, media download, Puppeteer patches — all replaced |
| `src/message-queue.js` | **~30%** | `MessageMedia` import, media sending, typing indicators via `pupPage.evaluate` |
| `src/admin/routes/connection.js` | **Full rewrite** | All event listeners, client status tracking, disconnect/connect endpoints |
| `src/admin/routes/groups.js` | **~15%** | `getChatById`, `getContactById`, `chat.participants` — only in the `/whatsapp-info` endpoint |
| `src/admin/routes/users.js` | **~15%** | `client.getContactById` used to resolve missing names. Must use adapter |
| `src/admin/routes/health.js` | **~5%** | Connection status checks `client.info`. Needs persistent adapter mock |
| `src/services/auth.js` | **~50%** | `chat.participants` and `p.id._serialized` |
| `src/active-listener.js` | **~5%** | Only receives `message` and `client` objects — mostly passthrough, just needs updated field access |
| `src/commands/*.js` | **~10% each** | `client.sendMessage()` signature, `message.getChat()`, `message.from` |
| `src/config.js` | **~5%** | Remove Chrome-related config, add Baileys auth path |
| `.env.example` | **Small** | Remove `CHROME_EXECUTABLE_PATH` example config |
| `package.json` | **Small** | Dependency swap |

**Files that need NO changes:**
- `src/db.js` — pure SQLite, no WhatsApp dependency
- `src/conversation-store.js` — pure DB operations
- `src/token-usage-tracker.js` — pure DB operations
- `src/pricing-config.js` — pure config
- `src/persona-parser.js` — pure file parsing
- `src/ai/gemini.js` — pure API calls
- `src/background-processor.js` — only calls DB
- `src/background-handlers/memories.js` — only calls DB + LLM
- `src/logger.js` — pure logging
- `src/phone-number-replacer.js` — pure string manipulation
- `src/message-processor.js` — pure string manipulation
- All admin views (`.ejs`) — no WhatsApp dependency (except connection.ejs which renders QR)
- `src/admin/routes/settings.js` — pure DB
- `src/admin/routes/personas.js` — pure file operations
- `src/cli/stats.js` — pure DB queries

---

## 5. Data Structure Translation

### Message Object

| whatsapp-web.js | Baileys | Notes |
|----------------|---------|-------|
| `message.id._serialized` | `msg.key.id` | Baileys key is `{ remoteJid, fromMe, id, participant }` |
| `message.from` | `msg.key.remoteJid` | e.g. `"120363XXX@g.us"` or `"1234567890@s.whatsapp.net"` |
| `message.author` | `msg.key.participant` | Only set in groups; sender's JID |
| `message.body` | `msg.message?.conversation \|\| msg.message?.extendedTextMessage?.text \|\| ''` | Text extraction varies by message type |
| `message.fromMe` | `msg.key.fromMe` | Boolean |
| `message.timestamp` | `msg.messageTimestamp` | Unix seconds (number or Long) |
| `message.hasMedia` | Check `msg.message?.imageMessage`, `msg.message?.audioMessage`, etc. | No single boolean |
| `message.type` | Determined by which key exists in `msg.message` | `'imageMessage'`, `'audioMessage'`, `'pttMessage'`, etc. |
| `message.hasQuotedMsg` | `!!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage` | Nested in contextInfo |
| `message.mentionedIds` | `msg.message?.extendedTextMessage?.contextInfo?.mentionedJid \|\| []` | Array of JIDs |
| `message._data.notifyName` | `msg.pushName` | Direct field |
| `message.duration` | `msg.message?.audioMessage?.seconds \|\| msg.message?.pttMessage?.seconds` | Audio duration |

### ID Format

| whatsapp-web.js | Baileys | Notes |
|----------------|---------|-------|
| `"1234567890@c.us"` | `"1234567890@s.whatsapp.net"` | **Important**: Baileys uses `@s.whatsapp.net` for individuals |
| `"120363XXX@g.us"` | `"120363XXX@g.us"` | Groups are the same |
| `"1234567890@lid"` | `"1234567890@lid"` | LID format same |

**Critical**: The DB currently stores IDs with `@c.us`. You have two options:
1. **Convert on the fly**: When reading/writing to DB, convert between `@s.whatsapp.net` and `@c.us`
2. **Migrate DB**: Update all stored IDs. This is riskier.

**Recommended**: Option 1 — create helper functions:
```javascript
function jidToDbId(jid) {
    return jid?.replace('@s.whatsapp.net', '@c.us') || jid;
}
function dbIdToJid(dbId) {
    return dbId?.replace('@c.us', '@s.whatsapp.net') || dbId;
}
```

### Client Methods

| whatsapp-web.js | Baileys |
|----------------|---------|
| `client.sendMessage(chatId, text)` | `sock.sendMessage(jid, { text })` |
| `client.sendMessage(chatId, text, { mentions })` | `sock.sendMessage(jid, { text, mentions })` |
| `client.sendMessage(chatId, media, { sendAudioAsVoice: true })` | `sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true })` |
| `client.getChatById(id)` | `await sock.groupMetadata(id)` (groups) or no equivalent for DMs |
| `client.getContactById(id)` | No direct equivalent; use `sock.onWhatsApp(number)` to check existence |
| `client.sendPresenceAvailable()` | `await sock.sendPresenceUpdate('available')` |
| `chat.sendStateTyping()` | `await sock.sendPresenceUpdate('composing', jid)` |
| `client.info.wid._serialized` | `sock.user.id` (format: `"1234567890:XX@s.whatsapp.net"`) — extract with `jidNormalizedUser(sock.user.id)` |
| `client.info.pushname` | `sock.user.name` |
| `client.info.wid.user` | Extract from `sock.user.id`: `sock.user.id.split(':')[0].split('@')[0]` |
| `message.getChat()` | No method — you already have `msg.key.remoteJid`; for group metadata use `sock.groupMetadata(jid)` |
| `message.getQuotedMessage()` | `msg.message?.extendedTextMessage?.contextInfo?.quotedMessage` — the quoted content is inline, not fetched |
| `message.downloadMedia()` | `const buffer = await downloadMediaMessage(msg, 'buffer', {})` |
| `MessageMedia.fromFilePath(path)` | `fs.readFileSync(path)` — just read the buffer directly |
| `client.resetState()` | N/A — just reconnect |
| `client.destroy()` | `sock.end(undefined)` or `sock.ws.close()` |
| `client.logout()` | `await sock.logout()` |
| `client.initialize()` | Create new socket with `makeWASocket(...)` |

---

## 6. src/bot.js — Full Rewrite

This is the largest file (~1450 lines) and needs complete rewriting. Below is the structural blueprint.

### 6.1 Imports to Replace

**Remove:**
```javascript
const puppeteerUtils = require('whatsapp-web.js/src/util/Puppeteer');
// ... entire Puppeteer compatibility patch (lines 1-24)
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
```

**Add:**
```javascript
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, getContentType, jidNormalizedUser, isJidGroup } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode'); // For admin panel QR
```

### 6.2 Client Creation (replaces `createAndInitClient`, lines 226-517)

**Current pattern:**
```javascript
const newClient = new Client(clientConfig);
newClient.on('qr', handler);
newClient.on('authenticated', handler);
newClient.on('ready', handler);
newClient.on('message', handler);
client.initialize();
```

**Baileys pattern:**
```javascript
const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }), // or 'debug' for troubleshooting
    browser: ['WispBot', 'Chrome', '130.0.0'],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
        // Required for retries — return message from DB if available
        return undefined;
    }
});

// Save credentials when they update
sock.ev.on('creds.update', saveCreds);

// Connection state changes (replaces qr, authenticated, ready, disconnected, change_state)
sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
        // QR code available — display in terminal and/or admin panel
        console.log('Scan QR code');
        qrcode.generate(qr, { small: true }); // CLI
        // For admin panel: store as data URL
        lastQrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === 'open') {
        // Equivalent to 'ready' event
        console.log('Connected!');
        await onReady(sock);
    }

    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
            // Reconnect with exponential backoff
            setTimeout(() => startSocket(), reconnectDelay);
        } else {
            // Logged out — need new QR scan
            console.log('Logged out. Delete auth_session to re-authenticate.');
        }
    }
});

// Message handler (replaces client.on('message'))
sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // type === 'notify' means real-time messages (including offline catch-up!)
    // type === 'append' means history sync (old messages) — usually ignore
    if (type !== 'notify') return;

    for (const msg of messages) {
        await handleIncomingMessage(sock, msg);
    }
});
```

### 6.3 Bot Identity Detection (replaces lines 335-366)

**Current:**
```javascript
const detectedUserId = client.info.wid._serialized;
const detectedNumber = client.info.wid.user;
const detectedPushname = client.info.pushname;
// ... LID detection via pupPage.evaluate
```

**Baileys:**
```javascript
const rawId = sock.user.id; // "1234567890:XX@s.whatsapp.net"
const normalizedId = jidNormalizedUser(rawId); // "1234567890@s.whatsapp.net"
const detectedNumber = normalizedId.split('@')[0];
const detectedPushname = sock.user.name || '';

// For DB storage, convert to @c.us format for backward compatibility
const detectedUserId = normalizedId.replace('@s.whatsapp.net', '@c.us');
config.botUserId = detectedUserId;
config.botNumber = detectedNumber;
// Note: Baileys normalizes all authors to standard JIDs (@s.whatsapp.net).
// Thus, `config.botLidUserId` is fully obsolete. Delete ALL references to `botLidUserId`
// (e.g. `mentionedIds.includes(config.botLidUserId)`) in `bot.js`.
```

### 6.4 Message Handler (replaces `setupMessageHandler`, lines 931-1134)

**Helper: extract message text from Baileys message**
```javascript
function getMessageText(msg) {
    const m = msg.message;
    if (!m) return '';
    return m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || '';
}
```

**Helper: extract message type**
```javascript
function getMessageType(msg) {
    if (!msg.message) return 'unknown';
    const type = getContentType(msg.message);
    // type will be: 'conversation', 'extendedTextMessage', 'imageMessage',
    // 'audioMessage', 'pttMessage', 'videoMessage', 'stickerMessage', etc.
    return type;
}
```

**Helper: check if message has media**
```javascript
function hasMedia(msg) {
    const type = getMessageType(msg);
    return ['imageMessage', 'audioMessage', 'pttMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(type);
}
```

**Helper: get quoted message info**
```javascript
function getQuotedInfo(msg) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.audioMessage?.contextInfo
        || msg.message?.pttMessage?.contextInfo;

    if (!contextInfo?.quotedMessage) return null;

    return {
        quotedMessage: contextInfo.quotedMessage,
        quotedParticipant: contextInfo.participant, // who sent the quoted message
        quotedMessageId: contextInfo.stanzaId,      // ID of the quoted message
        quotedBody: contextInfo.quotedMessage?.conversation
            || contextInfo.quotedMessage?.extendedTextMessage?.text
            || ''
    };
}
```

**Helper: safe contact equivalent (replaces `getSafeContact`)**
```javascript
function getSafeContact(msg) {
    const senderId = msg.key.participant || msg.key.remoteJid;
    const pushName = msg.pushName || 'Unknown User';
    return {
        id: jidToDbId(senderId),  // Convert to @c.us for DB compatibility
        pushname: pushName,
        name: pushName
    };
}
```

**Main message handler:**
```javascript
async function handleIncomingMessage(sock, msg) {
    // Ignore bot's own messages
    if (msg.key.fromMe) return;

    // Ignore protocol/status messages
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (!msg.message) return; // reaction, receipt, etc.

    // Dedup
    const msgId = msg.key.id;
    if (recentMessageIds.has(msgId)) return;
    recentMessageIds.add(msgId);
    setTimeout(() => recentMessageIds.delete(msgId), MESSAGE_DEDUP_TTL);

    updateLastMessageTime();

    const body = getMessageText(msg);
    const remoteJid = msg.key.remoteJid;
    const isGroup = isJidGroup(remoteJid);
    const senderId = jidToDbId(msg.key.participant || remoteJid);

    // Create a "message" object that mimics the shape the rest of the codebase expects
    // This is the ADAPTER LAYER — keeps downstream code changes minimal
    const message = {
        id: { _serialized: msgId },
        from: jidToDbId(remoteJid),
        author: isGroup ? senderId : undefined,
        body: body,
        fromMe: msg.key.fromMe,
        timestamp: Number(msg.messageTimestamp),
        hasMedia: hasMedia(msg),
        type: getMessageType(msg),
        mentionedIds: msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.map(jidToDbId) || [],
        hasQuotedMsg: !!getQuotedInfo(msg),
        _data: { notifyName: msg.pushName || 'Unknown User' },
        duration: msg.message?.audioMessage?.seconds || msg.message?.pttMessage?.seconds || 0,
        // Keep raw Baileys message for media download
        _rawMsg: msg,
        // Methods that downstream code calls
        getChat: async () => {
            if (isGroup) {
                try {
                    const metadata = await sock.groupMetadata(remoteJid);
                    return {
                        isGroup: true,
                        name: metadata.subject,
                        participants: metadata.participants.map(p => ({
                            id: { _serialized: jidToDbId(p.id) },
                            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                            isSuperAdmin: p.admin === 'superadmin'
                        })),
                        description: metadata.desc || '',
                        createdAt: metadata.creation,
                        sendStateTyping: async () => {
                            await sock.sendPresenceUpdate('composing', remoteJid);
                        }
                    };
                } catch (e) {
                    return { isGroup: true, name: remoteJid, participants: [] };
                }
            }
            return {
                isGroup: false,
                name: msg.pushName || remoteJid,
                participants: [],
                sendStateTyping: async () => {
                    await sock.sendPresenceUpdate('composing', remoteJid);
                }
            };
        },
        getQuotedMessage: async () => {
            const info = getQuotedInfo(msg);
            if (!info) return null;
            return {
                body: info.quotedBody,
                author: jidToDbId(info.quotedParticipant),
                from: jidToDbId(remoteJid),
                id: { _serialized: info.quotedMessageId },
                hasMedia: !!info.quotedMessage?.imageMessage || !!info.quotedMessage?.audioMessage,
                type: info.quotedMessage?.imageMessage ? 'image' : (info.quotedMessage?.audioMessage ? 'audio' : 'chat'),
                // For downloading quoted media, store the raw quoted message
                _rawQuotedMsg: info.quotedMessage,
                downloadMedia: async () => {
                    try {
                        const buffer = await downloadMediaMessage(
                            { message: info.quotedMessage, key: { id: info.quotedMessageId } }, 
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
                const type = getMessageType(msg);
                const mediaMsg = msg.message[type];
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

    // Now call the existing message processing logic with this adapter object
    // The rest of the handler (from the current setupMessageHandler) can remain mostly unchanged
    // because it uses: message.from, message.body, message.author, message.hasQuotedMsg,
    // message.getChat(), message.getQuotedMessage(), message.mentionedIds, etc.

    // ... (paste existing logic from setupMessageHandler, lines 937-1134)
}
```

### 6.5 Sending Messages (replaces `client.sendMessage`)

Create a wrapper that matches the current call pattern:

```javascript
// Adapter: wraps sock.sendMessage to match whatsapp-web.js's client.sendMessage(chatId, content, options)
async function sendMessage(sock, chatId, content, options = {}) {
    const jid = dbIdToJid(chatId); // Convert @c.us back to @s.whatsapp.net

    if (typeof content === 'string') {
        // Text message
        const payload = { text: content };
        if (options.mentions) {
            payload.mentions = options.mentions.map(dbIdToJid);
        }
        return sock.sendMessage(jid, payload);
    }

    // Media message (content is a media object from adapter)
    if (content._isMedia) {
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
        return sock.sendMessage(jid, payload);
    }
}
```

### 6.6 Media Download (replaces `processAndStoreImage` and `processAndStoreAudio`, lines 1184-1405)

**Current approach** has a 2-step fallback (standard download → pupPage.evaluate fallback). With Baileys, media download is simpler:

```javascript
async function processAndStoreImage(sock, message) {
    const msgId = message.id._serialized;
    try {
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
```

The entire pupPage.evaluate fallback (lines 1197-1278 and 1311-1386) is **deleted** — it only existed because whatsapp-web.js's `downloadMedia()` was unreliable. Baileys's `downloadMediaMessage()` is more reliable as it decrypts media directly.

### 6.7 Auth Check (replaces `checkAuth`, lines 79-106)

**Current** resolves LID → phone number via `client.getContactById()`:
```javascript
const contact = await client.getContactById(userId);
const phoneNumber = contact.number || (contact.id ? contact.id.user : null);
```

**Baileys**: LID resolution is different. Baileys may provide participant lists with both JID formats. The simplest approach:

```javascript
async function checkAuth(sock, userId, checkFn) {
    // 1. Direct match
    if (await checkFn(userId)) return true;

    // 2. Try @c.us ↔ @s.whatsapp.net conversion
    const altId = userId.includes('@s.whatsapp.net')
        ? userId.replace('@s.whatsapp.net', '@c.us')
        : userId.replace('@c.us', '@s.whatsapp.net');
    if (await checkFn(altId)) return true;

    // 3. If LID, try to resolve via group participant lists (cached)
    // Baileys doesn't have a direct getContactById equivalent
    // but you can try sock.onWhatsApp(number) to check existence
    if (userId.endsWith('@lid')) {
        const number = userId.split('@')[0];
        const cUsId = `${number}@c.us`;
        if (await checkFn(cUsId)) return true;
    }

    return false;
}
```

### 6.8 Things to DELETE from bot.js

The following sections are **completely removed** (Puppeteer-specific):

1. **Puppeteer compatibility patch** (lines 1-24) — not needed
2. **Chrome path detection** (lines 167-183) — not needed
3. **clientConfig** with Puppeteer options (lines 196-223) — replaced by makeWASocket config
4. **pupPage property descriptor trap** (lines 412-465) — not needed
5. **Monkey-patch attachEventListeners** (lines 468-512) — not needed
6. **forceCleanupBrowser** (lines 527-579) — not needed
7. **recoverClient 3-step recovery** (lines 581-695) — replaced by simple reconnect
8. **Health check with pupPage.evaluate** (lines 697-776) — replaced by connection.update events
9. **startDebugVersionPolling** (lines 782-808) — not needed
10. **startReadyTimeout** (lines 810-838) — not needed
11. **Chrome pre-flight check** (lines 847-855) — not needed
12. **pupPage.evaluate for Store access** — all gone
13. **fallback media download via pupPage.evaluate** (lines 1197-1278, 1311-1386) — not needed

---

## 7. src/message-queue.js — Partial Rewrite

### 7.1 Remove MessageMedia Import (line 8)

**Remove:**
```javascript
const { MessageMedia } = require('whatsapp-web.js');
```

### 7.2 Typing Indicator (lines 366-388)

**Current** (uses pupPage.evaluate for DMs):
```javascript
if (!chat.isGroup) {
    await client.pupPage.evaluate(async (chatId) => {
        await window.Store.PresenceUtils.sendPresenceAvailable();
        const chatModel = window.Store.Chat.get(chatId);
        if (chatModel) {
            await window.Store.ChatState.sendChatStateComposing(chatModel.id);
        }
    }, groupId);
} else {
    await chat.sendStateTyping();
}
```

**Replace with:**
```javascript
try {
    const jid = dbIdToJid(groupId);
    await sock.sendPresenceUpdate('composing', jid);
} catch (e) {
    logger.warn('Queue', `Failed to send typing state: ${e.message}`);
}
```

> Note: `sock` needs to be passed through or accessed via the `client` object. Since commands receive `client`, you can either:
> - Pass `sock` directly as `client` throughout, or
> - Create a wrapper object that exposes `sendMessage`, `sendPresenceUpdate`, etc.

### 7.3 TTS Audio Sending (lines 474-497)

**Current:**
```javascript
const media = MessageMedia.fromFilePath(audioFilePath);
media.filename = audioFilename;
await client.sendMessage(message.from, media, { sendAudioAsVoice: true });
```

**Replace with:**
```javascript
const audioBuffer = await fs.readFile(audioFilePath);
const jid = dbIdToJid(message.from);
await sock.sendMessage(jid, {
    audio: audioBuffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true  // voice note
});
```

### 7.4 Text Message Sending (line 507)

**Current:**
```javascript
await client.sendMessage(message.from, formattedText, { mentions });
```

**Replace with:**
```javascript
const jid = dbIdToJid(message.from);
await sock.sendMessage(jid, {
    text: formattedText,
    mentions: mentions.map(dbIdToJid)
});
```

### 7.5 Quoted Image Download Fallback (lines 620-639)

**Current** uses `quotedMsgObj.downloadMedia()`:
```javascript
const media = await quotedMsgObj.downloadMedia();
```

**With the adapter** this will work if the adapter object's `downloadMedia()` is implemented correctly. If the quoted message is from a previous session and the raw message isn't available, this download may fail — that's OK, same as current behavior.

### 7.6 resolveMentions (lines 157-233)

**No changes needed** — this function works with string participant IDs and doesn't call any whatsapp-web.js APIs. Just ensure the participant IDs passed in use the `@c.us` format (the adapter's `jidToDbId` handles this).

---

## 8. src/admin/routes/connection.js — Full Rewrite

### Current Structure

The file tracks connection status by listening to whatsapp-web.js events (`qr`, `authenticated`, `loading_screen`, `ready`, `auth_failure`, `disconnected`, `change_state`).

### Baileys Replacement

Since Baileys uses a single `connection.update` event, the listener attachment looks different:

```javascript
let lastQr = null;
let lastQrDataUrl = null;
let connectionStatus = 'waiting';
let statusMessage = 'Waiting for WhatsApp connection...';
let statusInfo = null;

function attachListeners(sock) {
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            lastQr = qr;
            try {
                const QRCode = require('qrcode');
                lastQrDataUrl = await QRCode.toDataURL(qr);
            } catch (e) { /* ignore */ }
            connectionStatus = 'qr';
            statusMessage = 'QR code ready. Scan with WhatsApp.';
            statusInfo = null;
        }

        if (connection === 'connecting') {
            connectionStatus = 'loading';
            statusMessage = 'Connecting to WhatsApp...';
            statusInfo = null;
        }

        if (connection === 'open') {
            lastQr = null;
            lastQrDataUrl = null;
            connectionStatus = 'ready';
            statusMessage = 'WhatsApp is connected';
            statusInfo = {
                pushname: sock.user?.name || null,
                phone: sock.user?.id?.split(':')[0]?.split('@')[0] || null
            };
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            lastQr = null;
            lastQrDataUrl = null;

            if (statusCode === DisconnectReason.loggedOut) {
                connectionStatus = 'disconnected';
                statusMessage = 'Logged out';
            } else {
                connectionStatus = 'reconnecting';
                statusMessage = 'Disconnected. Reconnecting...';
            }
            statusInfo = null;
        }
    });
}
```

### API endpoints

**`/api/connection/status`** — mostly the same, but add `qrDataUrl` for the admin panel:
```javascript
if (lastQrDataUrl) response.qrDataUrl = lastQrDataUrl;
```

**`/api/connection/disconnect`** — replace `client.logout()` with `sock.logout()`:
```javascript
await sock.logout();
// Delete auth session directory to force new QR scan
await fs.rm('./auth_session', { recursive: true, force: true });
```

**`/api/connection/connect`** — instead of `client.initialize()`, call the socket creation function:
```javascript
// Trigger reconnection by creating new socket
startSocket();
```

---

## 9. Other Admin Routes (groups.js, users.js, health.js)

### 9.1 src/admin/routes/groups.js

Only the `/api/groups/:groupId/whatsapp-info` endpoint needs changes (lines 401-462)

**Current:**
```javascript
const chat = await client.getChatById(groupId);
chat.participants.forEach(p => {
    const contact = await client.getContactById(p.id._serialized);
    name = contact.pushname || contact.name;
    // p.isAdmin, p.isSuperAdmin
});
```

**Replace with:**
```javascript
router.get('/api/groups/:groupId/whatsapp-info', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const sock = req.sharedState?.whatsappClient;
        if (!sock) {
            return res.status(503).json({ error: 'WhatsApp client not available' });
        }

        const jid = dbIdToJid(groupId);
        if (!isJidGroup(jid)) {
            return res.status(404).json({ error: 'Not a group' });
        }

        const metadata = await sock.groupMetadata(jid);

        const participants = [];
        for (const p of metadata.participants) {
            const pDbId = jidToDbId(p.id);
            const authorized = await isUserAuthorized(pDbId);
            const botAdmin = await isUserBotAdmin(pDbId);
            const isBot = pDbId === config.botUserId;
            // For names, check the DB first (from upsertUser)
            const name = await getUserNameById(pDbId) || pDbId.split('@')[0];
            participants.push({
                id: pDbId,
                name: name,
                isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                isSuperAdmin: p.admin === 'superadmin',
                isAuthorized: authorized,
                isBotAdmin: botAdmin,
                isBot: isBot
            });
        }

        res.json({
            name: metadata.subject || groupId,
            description: metadata.desc || '',
            participants: participants,
            participantCount: participants.length,
            createdAt: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null
        });
    } catch (error) {
        logger.error('Admin', 'Error fetching WhatsApp info: ' + error.message);
        res.status(500).json({ error: 'Failed to fetch WhatsApp info' });
    }
});
```

Also remove the `client.pupPage.isClosed()` check (line 410-412) — no longer needed.

### 9.2 src/admin/routes/users.js

In `resolveNames`, the loop uses `client.getContactById(u.id)` to progressively hydrate names from the DB. Baileys has a different profile fetching model.
**Fix:** Provide a firm mock implementation of `getContactById()` inside `bot.js` (see Section 12) or adapt `users.js` to query via `sock.user` and `sock.onWhatsApp(number)`.

### 9.3 src/admin/routes/health.js

The `/api/health` route checks connection via `health.status = (client && client.info) ? 'connected' : 'disconnected';`.
**Fix:** The `bot.js` adapter wrapper shown in Section 12 solves this by always providing `info.wid` fields on the client object, resolving this gap seamlessly.

---

## 10. src/services/auth.js — Update

**Current:**
```javascript
const participantIds = participants.map(p => p.id._serialized);
```

**With adapter**, this still works because the adapter maps `p.id._serialized` to the DB format. No changes needed if the chat object returned by `message.getChat()` uses the adapter format.

If called directly with a Baileys group metadata result:
```javascript
const participantIds = participants.map(p => jidToDbId(p.id));
```

---

## 11. src/active-listener.js — Minor Update

This file receives `message` and `client` objects from `bot.js`. If the adapter layer in bot.js creates compatible objects, **no changes are needed** in this file. It only accesses:
- `message.body` — set by adapter
- `client` — passed through to `handleBotInvocation`

---

## 12. Command Files — Pattern Update

All command files follow this pattern:
```javascript
async function handler(client, message, config) {
    // Use: client.sendMessage(message.from, text)
    // Use: message.from, message.body, message.author, message.getChat()
}
```

### Strategy: Adapter Approach

If the adapter in bot.js creates a compatible `client` wrapper and `message` adapter, **most command files need zero changes**. The wrapper object would be:

```javascript
const clientAdapter = {
    sendMessage: (chatId, content, options) => sendMessage(sock, chatId, content, options),
    getChatById: async (id) => {
        const jid = dbIdToJid(id);
        if (isJidGroup(jid)) {
            const metadata = await sock.groupMetadata(jid);
            return {
                isGroup: true,
                name: metadata.subject,
                participants: metadata.participants.map(p => ({
                    id: { _serialized: jidToDbId(p.id) },
                    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                    isSuperAdmin: p.admin === 'superadmin'
                })),
                description: metadata.desc || ''
            };
        }
        return { isGroup: false, name: id };
    },
    getContactById: async (id) => {
        const name = await getUserNameById(jidToDbId(id));
        return {
            id: { _serialized: jidToDbId(id) },
            pushname: name || id.split('@')[0],
            name: name || id.split('@')[0],
            number: id.split('@')[0]
        };
    },
    // Expose sock for direct access when needed
    _sock: sock,
    // For compatibility with connection.js status checks
    info: {
        wid: { _serialized: config.botUserId, user: config.botNumber },
        pushname: config.botName
    }
};
```

With this adapter, the following commands need **zero changes**:
- `ping.js`, `clear.js`, `switch.js`, `tts.js`, `usage.js`, `model.js`, `group-id.js`, `set-group-name.js`, `audio.js`, `remember.js`, `search.js`, `list-messages.js`, `list-add-requests.js`, `accept-add-request.js`, `accept-all-add-requests.js`, `check-authorized.js`

Commands that call `message.getChat()`:
- `authorize-all.js` — calls `chat.participants` via `authorizeGroupParticipants(chat)`
- `setup-group.js` — calls `chat.isGroup` and `authorizeGroupParticipants(chat)`

These work if the adapter's `getChat()` returns the right shape (which it does — see section 6.4).

---

## 13. Offline Message Handling

This is the **primary motivation** for the migration.

### How Baileys delivers offline messages

When the bot reconnects after being offline, Baileys fires:
```javascript
sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // type === 'notify' → real-time messages INCLUDING those received while offline
    // type === 'append' → historical sync (old messages being loaded into memory)
});
```

Messages received while offline arrive as `type: 'notify'` events shortly after `connection: 'open'`. They are **not** marked differently from live messages — they fire the same event handler.

### Deduplication for offline messages

The existing `recentMessageIds` Set with a 5-second TTL is too short for offline messages that may arrive in bursts. Additionally, use the database's unique constraint on `whatsapp_message_id` as a second line of defense:

```javascript
// In processAndStoreMessage, the DB INSERT uses:
// CREATE UNIQUE INDEX idx_conversations_unique_wmid ON conversations(whatsapp_message_id)
// However, the DB query is wrapped in a try/catch. If it fails, the handler will STILL
// CONTINUE EXECUTION. You MUST add a fast short-circuit check right at the top of the message listener:
const exists = await dbIdExists(msgId);
if (exists) return; // Drop duplicate offline message before any AI processing
```

For bot response triggers (mention/reply detection), the existing logic already handles this correctly — it checks each message independently.

### Edge case: old messages during history sync

Baileys also fires `messages.upsert` with `type: 'append'` during initial history sync. **Always filter by `type === 'notify'`** to avoid processing ancient messages.

---

## 14. Session & Authentication

### Current (whatsapp-web.js)
```
./tokens/session-sessionName/  (Chrome profile data, managed by LocalAuth)
```

### Baileys
```
./auth_session/  (JSON files, managed by useMultiFileAuthState)
├── creds.json           (credentials)
├── app-state-sync-key-*.json
├── pre-key-*.json
├── sender-key-*.json
├── session-*.json
```

### Migration path

- The session formats are **incompatible** — users will need to re-scan QR code after migration.
- Delete `./tokens/` directory (or keep for rollback).
- First run with Baileys will prompt for QR scan.
- Add `auth_session/` to `.gitignore`.

---

## 15. Health Check & Recovery

### Current (complex 3-step, lines 581-838)

1. Step 1: `client.resetState()` via CDP
2. Step 2: Page reload via `pupPage.goto()`
3. Step 3: Create new `Client` instance, kill zombie Chrome

### Baileys (simple)

```javascript
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
            // Session expired — need new QR
            logger.warn('Recovery', 'Logged out. Need new QR scan.');
            // Delete session and restart
            await fs.rm('./auth_session', { recursive: true, force: true });
            startSocket();
            return;
        }

        // All other disconnects: reconnect with exponential backoff
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
        logger.info('Recovery', `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
        setTimeout(() => startSocket(), delay);
    }

    if (connection === 'open') {
        reconnectAttempts = 0; // Reset on successful connection
        logger.info('Recovery', 'Connected successfully');
    }
});
```

### Health check (optional, simpler)

Since Baileys auto-detects disconnections via the WebSocket, the periodic health check can be much simpler — or even removed entirely. If you want to keep it for the "5 minutes with no messages" presence ping:

```javascript
setInterval(async () => {
    if (connectionStatus !== 'ready') return;
    const silentMs = Date.now() - lastMessageReceivedAt;
    if (silentMs > 300000) { // 5 minutes
        try {
            await sock.sendPresenceUpdate('available');
        } catch (e) {
            logger.warn('HealthCheck', `Presence ping failed: ${e.message}`);
        }
    }
}, 60000);
```

No need to check browser state, page alive, socket state via evaluate, etc.

---

## 16. QR Code for Admin Panel

### Current

The admin panel receives QR as a string and renders it client-side. The `connection.js` route stores `lastQr` (raw QR string).

### Baileys

Same approach works. Baileys provides the QR string in the `connection.update` event. Store it and serve via the API:

```javascript
// In connection route
if (qr) {
    lastQr = qr;
    // Also generate data URL for direct display
    const QRCode = require('qrcode');
    lastQrDataUrl = await QRCode.toDataURL(qr);
}

// In API response
if (lastQrDataUrl) response.qrDataUrl = lastQrDataUrl;
```

The admin panel JS can display `qrDataUrl` directly as an `<img src>`. Alternatively, keep using a client-side QR renderer with the raw `lastQr` string.

---

## 17. Testing Checklist

### Phase 1: Connection
- [ ] First-time QR scan works
- [ ] Bot identity auto-detected (name, number, user ID)
- [ ] Reconnection after network drop
- [ ] Session persistence across restarts (no re-scan needed)
- [ ] Admin panel shows correct connection status
- [ ] Admin panel shows QR code
- [ ] Admin panel disconnect/connect works
- [ ] Graceful shutdown (SIGINT)

### Phase 2: Message Receiving
- [ ] Receive text messages in groups
- [ ] Receive text messages in DMs
- [ ] Receive image messages
- [ ] Receive audio/voice messages
- [ ] Receive messages with mentions
- [ ] Receive messages with quotes/replies
- [ ] Bot mention detection works
- [ ] Bot reply detection works
- [ ] Message deduplication works
- [ ] **Offline messages processed on reconnect** (the main motivation!)

### Phase 3: Message Sending
- [ ] Send text messages
- [ ] Send text messages with @mentions (formatted correctly)
- [ ] Send voice notes (TTS audio)
- [ ] Send error/status messages
- [ ] Typing indicator shows

### Phase 4: Commands
- [ ] `!ping` works
- [ ] `!clear` works
- [ ] `!switch <persona>` works
- [ ] `!tts on/off` works
- [ ] `!usage` works
- [ ] `!setupgroup` works (reads participants)
- [ ] `!authorizeall` works (reads participants)
- [ ] `!addme` works

### Phase 5: Media
- [ ] Image download and storage
- [ ] Audio download and storage
- [ ] Audio duration cap enforcement
- [ ] Quoted image fallback download

### Phase 6: Admin Panel
- [ ] Groups list loads
- [ ] Group detail page loads
- [ ] WhatsApp info (participants) loads for groups
- [ ] Group settings save
- [ ] Chat viewer works
- [ ] Usage stats display

### Phase 7: Advanced Features
- [ ] Active listening triggers correctly
- [ ] Background processor (memories) works
- [ ] Authorization check (LID resolution)
- [ ] Group auto-registration on first message
- [ ] User profile sync (upsertUser)

### Phase 8: Reliability
- [ ] 24-hour stability test
- [ ] Recovery from WiFi disconnect
- [ ] Recovery from server sleep/wake
- [ ] No memory leaks (no Chrome process!)
- [ ] Multiple groups processing simultaneously

---

## Appendix A: Utility Functions Module

Create `src/whatsapp-utils.js` with shared utilities:

```javascript
const { jidNormalizedUser, isJidGroup } = require('@whiskeysockets/baileys');

/**
 * Convert a Baileys JID to the @c.us format stored in the database.
 * "1234567890@s.whatsapp.net" → "1234567890@c.us"
 * Groups (@g.us) and LIDs (@lid) pass through unchanged.
 */
function jidToDbId(jid) {
    if (!jid) return jid;
    return jid.replace('@s.whatsapp.net', '@c.us');
}

/**
 * Convert a DB ID (@c.us format) back to a Baileys JID.
 * "1234567890@c.us" → "1234567890@s.whatsapp.net"
 */
function dbIdToJid(dbId) {
    if (!dbId) return dbId;
    return dbId.replace('@c.us', '@s.whatsapp.net');
}

/**
 * Extract phone number from any WhatsApp ID format.
 */
function extractNumber(id) {
    if (!id) return null;
    return id.split(':')[0].split('@')[0];
}

/**
 * Get the bot's normalized user ID from the socket.
 */
function getBotId(sock) {
    if (!sock.user?.id) return null;
    return jidNormalizedUser(sock.user.id);
}

module.exports = { jidToDbId, dbIdToJid, extractNumber, getBotId, isJidGroup };
```

## Appendix B: Recommended Implementation Order

1. **Create `src/whatsapp-utils.js`** — shared JID conversion functions
2. **Update `package.json`** — swap dependencies
3. **Rewrite `src/bot.js`** — the core. Use the adapter pattern so downstream files need minimal changes
4. **Update `src/message-queue.js`** — remove MessageMedia, update typing/sending
5. **Rewrite `src/admin/routes/connection.js`** — new event model
6. **Update `src/admin/routes/groups.js`** — only the whatsapp-info endpoint
7. **Update `src/services/auth.js`** — participant ID extraction
8. **Update `src/config.js`** — remove Chrome config, add auth session path
9. **Update `.gitignore`** — add `auth_session/`
10. **Test each phase** from the checklist above

## Appendix C: Key Baileys Gotchas

1. **`messages.upsert` fires in batches** — `messages` is an array, iterate over it
2. **Message content is nested** — `msg.message.conversation` vs `msg.message.extendedTextMessage.text` vs `msg.message.imageMessage.caption` etc.
3. **`sock.user.id` includes a device suffix** — use `jidNormalizedUser()` to normalize
4. **Group metadata is async** — `sock.groupMetadata(jid)` returns a promise
5. **JIDs use `@s.whatsapp.net`** not `@c.us` — need conversion for DB compatibility
6. **Baileys logger is noisy** — set `logger: pino({ level: 'silent' })` or `'warn'`
7. **`downloadMediaMessage` can fail for old messages** — the media encryption keys expire after ~2 weeks
8. **Baileys uses protobuf internally** — message structures are more complex than whatsapp-web.js's simplified objects
9. **`getMessage` callback** — Baileys calls this when retrying failed messages. Return the proto message from your DB if possible, or `undefined` to skip retries.
10. **Connection update events fire multiple times** — always check `connection` value, don't assume order
