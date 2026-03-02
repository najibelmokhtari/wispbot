const { getDatabase } = require('./db');

const MAX_MESSAGES = 1000;

class ConversationStore {
  async initialize() {
    const db = await getDatabase();
    // The table creation is now handled in db.js, so we don't need to do it here
  }

  async loadConversation(groupId, limit = MAX_MESSAGES) {
    const db = await getDatabase();
    const query = `
      SELECT * FROM conversations
      WHERE group_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    const rows = await db.all(query, [groupId, limit]);
    return rows.reverse();
  }

  async addMessageToConversation(groupId, message) {
    const db = await getDatabase();
    const query = `
      INSERT OR IGNORE INTO conversations (
        group_id, sender, sender_id, message, timestamp, 
        quoted_participant, quoted_msg, image_id, 
        whatsapp_message_id, quoted_whatsapp_message_id,
        audio_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.run(query, [
      groupId,
      message.sender,
      message.senderId,
      message.message,
      message.timestamp,
      message.quotedParticipant,
      message.quotedMsg ? JSON.stringify(message.quotedMsg) : null,
      message.imageId,
      message.whatsappMessageId,
      message.quotedWhatsappMessageId,
      message.audioId
    ]);

    // Ensure we don't exceed MAX_MESSAGES
    const countQuery = 'SELECT COUNT(*) as count FROM conversations WHERE group_id = ?';
    const { count } = await db.get(countQuery, [groupId]);

    if (count > MAX_MESSAGES) {
      const deleteQuery = `
        DELETE FROM conversations
        WHERE id IN (
          SELECT id FROM conversations
          WHERE group_id = ?
          ORDER BY timestamp ASC
          LIMIT ?
        )
      `;
      await db.run(deleteQuery, [groupId, count - MAX_MESSAGES]);
    }

    return this.loadConversation(groupId);
  }

  async updateImageId(whatsappMessageId, imageId) {
    const db = await getDatabase();
    await db.run(
      'UPDATE conversations SET image_id = ?, message = ? WHERE whatsapp_message_id = ?',
      [imageId, `Sent image id: ${imageId}`, whatsappMessageId]
    );
  }
}

module.exports = new ConversationStore();