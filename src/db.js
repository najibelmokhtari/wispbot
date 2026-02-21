const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs').promises;
const logger = require('./logger');

let db;
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000; // 1 second

async function initializeDatabase(retries = MAX_RETRIES) {
  if (db) {
    return db;
  }

  try {
    // Ensure the directory exists
    await fs.mkdir('./data', { recursive: true });

    db = await open({
      filename: './data/database.sqlite',
      driver: sqlite3.Database
    });

    // Enable WAL mode
    await db.exec('PRAGMA journal_mode = WAL;');

    // Increase the busy timeout
    await db.exec('PRAGMA busy_timeout = 5000;');

    // Create tables if they don't exist
    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        sender TEXT,
        sender_id TEXT,
        message TEXT,
        timestamp TEXT,
        quoted_participant TEXT,
        quoted_msg TEXT,
        image_id TEXT,
        audio_id TEXT,
        whatsapp_message_id TEXT,
        quoted_whatsapp_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        user_id TEXT PRIMARY KEY,
        tokens INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS group_info (
        group_id TEXT PRIMARY KEY,
        group_name TEXT,
        group_summary JSON,
        default_prompt_name TEXT DEFAULT 'default',
        last_processed_timestamp TEXT,
        google_search_enabled INTEGER DEFAULT 1,
        audio_enabled INTEGER DEFAULT 1,
        ai_model TEXT DEFAULT 'gemini-2.5-pro',
        authorization_check_enabled INTEGER DEFAULT 0,
        tts_enabled INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS add_requests (
        user_id TEXT PRIMARY KEY,
        user_name TEXT
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        whatsapp_name TEXT,
        custom_alias TEXT,
        first_seen_timestamp TEXT,
        last_seen_timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Create indexes for faster queries
      CREATE INDEX IF NOT EXISTS idx_conversations_group_timestamp
      ON conversations(group_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_message_id
      ON conversations(whatsapp_message_id);
    `);

    // Migration: Add google_search_enabled column if it doesn't exist (for existing DBs)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN google_search_enabled INTEGER DEFAULT 1');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add audio_enabled column if it doesn't exist (for existing DBs)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN audio_enabled INTEGER DEFAULT 1');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add audio_id column to conversations if it doesn't exist
    try {
      await db.exec('ALTER TABLE conversations ADD COLUMN audio_id TEXT');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add ai_model column to group_info if it doesn't exist
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN ai_model TEXT DEFAULT \'gemini-2.5-pro\'');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add authorization_check_enabled column if it doesn't exist (for existing DBs)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN authorization_check_enabled INTEGER DEFAULT 0');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add tts_enabled column if it doesn't exist (for existing DBs)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN tts_enabled INTEGER DEFAULT 1');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add custom_message_limit column to group_info (Phase 5 - persist !remember)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN custom_message_limit INTEGER DEFAULT NULL');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add background_processing_enabled column to group_info
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN background_processing_enabled INTEGER DEFAULT 0');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add is_active column to group_info (unconfigured groups feature)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN is_active INTEGER DEFAULT 0');
      // One-time: mark all existing groups as active (they were already configured)
      await db.exec('UPDATE group_info SET is_active = 1 WHERE is_active = 0');
      logger.info('DB', 'Migrated: added is_active column, set existing groups to active');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add unique partial index on whatsapp_message_id to prevent duplicates (Phase 5)
    try {
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_unique_wmid ON conversations(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL');
    } catch (error) {
      // Index likely exists, ignore error
    }

    // Migration: Add is_authorized column to users if it doesn't exist
    try {
      await db.exec('ALTER TABLE users ADD COLUMN is_authorized INTEGER DEFAULT 0');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add is_admin column to users if it doesn't exist
    try {
      await db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add per-group debounce config columns
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN background_debounce_ms INTEGER DEFAULT NULL');
    } catch (error) {
      // Column likely exists, ignore error
    }
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN background_message_threshold INTEGER DEFAULT NULL');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add audio history mode column (tagged or history)
    try {
      await db.exec("ALTER TABLE group_info ADD COLUMN audio_history_mode TEXT DEFAULT 'tagged'");
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add audio history count column (how many recent audios to include)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN audio_history_count INTEGER DEFAULT 1');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add audio duration cap column (max seconds, NULL = no cap)
    try {
      await db.exec('ALTER TABLE group_info ADD COLUMN audio_duration_cap INTEGER DEFAULT 900');
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add TTS voice column (voice name for text-to-speech)
    try {
      await db.exec("ALTER TABLE group_info ADD COLUMN tts_voice TEXT DEFAULT NULL");
    } catch (error) {
      // Column likely exists, ignore error
    }

    // Migration: Add TTS trigger mode column ('keyword' or 'always')
    try {
      await db.exec("ALTER TABLE group_info ADD COLUMN tts_trigger_mode TEXT DEFAULT NULL");
    } catch (error) {
      // Column likely exists, ignore error
    }

    logger.info('DB', 'Database initialized successfully');
    return db;
  } catch (error) {
    logger.error('DB', 'Error initializing database: ' + error.message);
    if (retries > 0) {
      logger.info('DB', `Retrying database initialization in ${RETRY_DELAY}ms... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return initializeDatabase(retries - 1);
    } else {
      throw new Error('Failed to initialize database after multiple attempts');
    }
  }
}

async function getDatabase() {
  if (!db) {
    db = await initializeDatabase();
  }
  return db;
}

async function closeDatabase() {
  if (db) {
    await db.close();
    db = null;
    logger.info('DB', 'Database connection closed');
  }
}

// --- Bot Settings (key-value store) ---

async function getBotSetting(key) {
  const db = await getDatabase();
  const row = await db.get('SELECT value FROM bot_settings WHERE key = ?', key);
  return row ? row.value : null;
}

async function setBotSetting(key, value) {
  const db = await getDatabase();
  await db.run('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

async function getAllBotSettings() {
  const db = await getDatabase();
  const rows = await db.all('SELECT key, value FROM bot_settings');
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function getOrCreateGroupInfo(groupId, groupName) {
  const db = await getDatabase();
  let groupInfo = await db.get('SELECT * FROM group_info WHERE group_id = ?', groupId);

  if (!groupInfo) {
    const defaultSummary = JSON.stringify({
      key_facts: '',
      recent_events: ''
    });

    // Use admin-configured defaults from bot_settings, falling back to hardcoded defaults
    const defaultPersona = await getBotSetting('default_persona') || 'default';
    const defaultModel = await getBotSetting('default_ai_model') || 'gemini-2.5-pro';
    const defaultSearch = parseInt(await getBotSetting('default_google_search') || '1');
    const defaultAudio = parseInt(await getBotSetting('default_audio') || '1');
    const defaultTts = parseInt(await getBotSetting('default_tts') || '1');
    const defaultAuth = parseInt(await getBotSetting('default_auth_check') || '0');
    const defaultBgProcessing = parseInt(await getBotSetting('default_background_processing') || '0');
    const defaultBgDebounceMs = await getBotSetting('default_background_debounce_ms') || null;
    const defaultBgMsgThreshold = await getBotSetting('default_background_message_threshold') || null;
    const defaultAudioHistoryMode = await getBotSetting('default_audio_history_mode') || 'tagged';
    const defaultAudioHistoryCount = parseInt(await getBotSetting('default_audio_history_count') || '1');
    const defaultAudioDurationCap = await getBotSetting('default_audio_duration_cap');
    const audioDurationCap = defaultAudioDurationCap !== null ? parseInt(defaultAudioDurationCap) : 900;
    const defaultTtsTriggerMode = await getBotSetting('default_tts_trigger_mode') || 'keyword';

    await db.run(
      'INSERT INTO group_info (group_id, group_name, group_summary, default_prompt_name, google_search_enabled, audio_enabled, ai_model, authorization_check_enabled, tts_enabled, custom_message_limit, is_active, background_processing_enabled, background_debounce_ms, background_message_threshold, audio_history_mode, audio_history_count, audio_duration_cap, tts_trigger_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [groupId, groupName, defaultSummary, defaultPersona, defaultSearch, defaultAudio, defaultModel, defaultAuth, defaultTts, null, 0, defaultBgProcessing, defaultBgDebounceMs ? parseInt(defaultBgDebounceMs) : null, defaultBgMsgThreshold ? parseInt(defaultBgMsgThreshold) : null, defaultAudioHistoryMode, defaultAudioHistoryCount, audioDurationCap, defaultTtsTriggerMode]
    );

    groupInfo = await db.get('SELECT * FROM group_info WHERE group_id = ?', groupId);
  }

  return groupInfo;
}

async function updateGroupInfo(groupId, updateData) {
  const db = await getDatabase();
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(updateData)) {
    updates.push(`${key} = ?`);
    values.push(value);
  }

  values.push(groupId);

  const query = `UPDATE group_info SET ${updates.join(', ')} WHERE group_id = ?`;

  try {
    const result = await db.run(query, values);
    logger.info('DB', `Updated group info for ${groupId}. Changes: ${result.changes}`);
    return result.changes > 0;
  } catch (error) {
    logger.error('DB', `Error updating group info for ${groupId}: ${error.message}`);
    throw error;
  }
}

async function addAddRequest(userId, userName) {
  const db = await getDatabase();
  await db.run('INSERT OR REPLACE INTO add_requests (user_id, user_name) VALUES (?, ?)', [userId, userName]);
}

async function getAddRequests() {
  const db = await getDatabase();
  return await db.all('SELECT * FROM add_requests');
}

async function removeAddRequest(userId) {
  const db = await getDatabase();
  await db.run('DELETE FROM add_requests WHERE user_id = ?', userId);
}

async function clearAddRequests() {
  const db = await getDatabase();
  await db.run('DELETE FROM add_requests');
}

// User Alias Functions

async function upsertUser(userId, whatsappName) {
  validateUserId(userId);
  const db = await getDatabase();
  const now = new Date().toISOString();

  // Check if user exists
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

  if (user) {
    // Update whatsapp_name (keep custom_alias if it exists) and last_seen
    await db.run(
      'UPDATE users SET whatsapp_name = ?, last_seen_timestamp = ? WHERE user_id = ?',
      [whatsappName, now, userId]
    );
  } else {
    // Create new user
    await db.run(
      'INSERT INTO users (user_id, whatsapp_name, first_seen_timestamp, last_seen_timestamp) VALUES (?, ?, ?, ?)',
      [userId, whatsappName, now, now]
    );
  }
}

async function setCustomAlias(userId, alias) {
  const db = await getDatabase();
  // We update the custom_alias. The user should already exist via upsertUser.
  await db.run(
    'UPDATE users SET custom_alias = ? WHERE user_id = ?',
    [alias, userId]
  );
}

async function getUserAlias(userId) {
  const db = await getDatabase();
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

  if (!user) return 'Unknown User';

  // Priority: Custom Alias > WhatsApp Profile Name > User ID (fallback)
  return user.custom_alias || user.whatsapp_name || user.user_id;
}

async function getUserNameById(userId) {
  const db = await getDatabase();
  const user = await db.get('SELECT custom_alias, whatsapp_name FROM users WHERE user_id = ?', userId);
  if (!user) return null;
  return user.custom_alias || user.whatsapp_name || null;
}

async function getAllGroupInfo() {
  const db = await getDatabase();
  return await db.all('SELECT * FROM group_info ORDER BY group_name');
}

async function getActiveGroups() {
  const db = await getDatabase();
  return await db.all('SELECT * FROM group_info WHERE is_active = 1 ORDER BY group_name');
}

async function getInactiveGroups() {
  const db = await getDatabase();
  return await db.all('SELECT * FROM group_info WHERE is_active = 0 ORDER BY group_name');
}

// --- Validation Helpers ---

function validateUserId(userId) {
  if (!/^\d+@(c\.us|lid|g\.us)$/.test(userId)) {
    throw new Error(`Invalid user ID format: ${userId}`);
  }
}

// --- Authorization Functions ---

async function isUserAuthorized(userId) {
  const db = await getDatabase();
  const row = await db.get('SELECT is_authorized FROM users WHERE user_id = ?', userId);
  return row ? row.is_authorized === 1 : false;
}

async function isUserAdmin(userId) {
  const db = await getDatabase();
  const row = await db.get('SELECT is_admin FROM users WHERE user_id = ?', userId);
  return row ? row.is_admin === 1 : false;
}

async function setUserAuthorized(userId, authorized) {
  validateUserId(userId);
  const db = await getDatabase();
  const now = new Date().toISOString();
  const flag = authorized ? 1 : 0;
  // Upsert: create user if not exists, then set flag
  const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
  if (existing) {
    await db.run('UPDATE users SET is_authorized = ? WHERE user_id = ?', [flag, userId]);
  } else {
    await db.run(
      'INSERT INTO users (user_id, is_authorized, first_seen_timestamp, last_seen_timestamp) VALUES (?, ?, ?, ?)',
      [userId, flag, now, now]
    );
  }
}

async function setUserAdmin(userId, isAdmin) {
  validateUserId(userId);
  const db = await getDatabase();
  const now = new Date().toISOString();
  const flag = isAdmin ? 1 : 0;
  const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
  if (existing) {
    await db.run('UPDATE users SET is_admin = ? WHERE user_id = ?', [flag, userId]);
  } else {
    await db.run(
      'INSERT INTO users (user_id, is_admin, first_seen_timestamp, last_seen_timestamp) VALUES (?, ?, ?, ?)',
      [userId, flag, now, now]
    );
  }
}

async function getAuthorizedUserIds() {
  const db = await getDatabase();
  const rows = await db.all('SELECT user_id FROM users WHERE is_authorized = 1');
  return rows.map(r => r.user_id);
}

async function getAdminUserIds() {
  const db = await getDatabase();
  const rows = await db.all('SELECT user_id FROM users WHERE is_admin = 1');
  return rows.map(r => r.user_id);
}

function extractPhone(userId) {
  if (userId.endsWith('@c.us')) return '+' + userId.replace('@c.us', '');
  return null;
}

async function getAuthorizedUsersWithNames() {
  const db = await getDatabase();
  const rows = await db.all('SELECT user_id, whatsapp_name, custom_alias FROM users WHERE is_authorized = 1');
  return rows.map(r => ({
    id: r.user_id,
    name: r.custom_alias || r.whatsapp_name || null,
    phone: extractPhone(r.user_id)
  }));
}

async function getAdminUsersWithNames() {
  const db = await getDatabase();
  const rows = await db.all('SELECT user_id, whatsapp_name, custom_alias FROM users WHERE is_admin = 1');
  return rows.map(r => ({
    id: r.user_id,
    name: r.custom_alias || r.whatsapp_name || null,
    phone: extractPhone(r.user_id)
  }));
}

async function importAuthFromFiles(authorizedFile, adminFile) {
  const fs = require('fs').promises;
  const db = await getDatabase();

  // Only import if no users are flagged yet (first run after migration)
  const hasAuth = await db.get('SELECT 1 FROM users WHERE is_authorized = 1 OR is_admin = 1');
  if (hasAuth) return { authorized: 0, admin: 0 };

  const now = new Date().toISOString();
  let authorizedCount = 0;
  let adminCount = 0;

  async function readIds(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    } catch {
      return [];
    }
  }

  const authorizedIds = await readIds(authorizedFile);
  for (const userId of authorizedIds) {
    const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
    if (existing) {
      await db.run('UPDATE users SET is_authorized = 1 WHERE user_id = ?', userId);
    } else {
      await db.run(
        'INSERT INTO users (user_id, is_authorized, first_seen_timestamp, last_seen_timestamp) VALUES (?, 1, ?, ?)',
        [userId, now, now]
      );
    }
    authorizedCount++;
  }

  const adminIds = await readIds(adminFile);
  for (const userId of adminIds) {
    const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
    if (existing) {
      await db.run('UPDATE users SET is_admin = 1 WHERE user_id = ?', userId);
    } else {
      await db.run(
        'INSERT INTO users (user_id, is_admin, first_seen_timestamp, last_seen_timestamp) VALUES (?, 1, ?, ?)',
        [userId, now, now]
      );
    }
    adminCount++;
  }

  return { authorized: authorizedCount, admin: adminCount };
}

process.on('SIGINT', async () => {
  logger.info('DB', 'Closing database connection...');
  await closeDatabase();
  process.exit(0);
});

module.exports = {
  getDatabase,
  closeDatabase,
  getBotSetting,
  setBotSetting,
  getAllBotSettings,
  getOrCreateGroupInfo,
  getAllGroupInfo,
  getActiveGroups,
  getInactiveGroups,
  updateGroupInfo,
  addAddRequest,
  getAddRequests,
  removeAddRequest,
  clearAddRequests,
  upsertUser,
  setCustomAlias,
  getUserAlias,
  getUserNameById,
  isUserAuthorized,
  isUserAdmin,
  setUserAuthorized,
  setUserAdmin,
  getAuthorizedUserIds,
  getAdminUserIds,
  getAuthorizedUsersWithNames,
  getAdminUsersWithNames,
  importAuthFromFiles,
  validateUserId
};