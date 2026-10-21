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
        audio_id, audio_duration
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      message.audioId,
      message.audioDuration || null
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

  /**
   * Returns the stored audio record for a group, or null if the audio isn't part of that chat.
   */
  async getAudioRecord(groupId, audioId) {
    const db = await getDatabase();
    return db.get(
      'SELECT audio_id, audio_duration, audio_preview, audio_transcript FROM conversations WHERE group_id = ? AND audio_id = ? LIMIT 1',
      [groupId, audioId]
    );
  }

  async setAudioPreview(audioId, preview, duration = null) {
    const db = await getDatabase();
    await db.run(
      'UPDATE conversations SET audio_preview = ?, audio_duration = COALESCE(audio_duration, ?) WHERE audio_id = ?',
      [preview, duration ? Math.round(duration) : null, audioId]
    );
  }

  async setAudioTranscript(audioId, transcript) {
    const db = await getDatabase();
    await db.run('UPDATE conversations SET audio_transcript = ? WHERE audio_id = ?', [transcript, audioId]);
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