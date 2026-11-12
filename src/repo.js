'use strict';

const SESSION_COLUMNS = [
  'session_id', 'user_id', 'client_session_id', 'start_time', 'end_time', 'duration_sec',
  'total_distance', 'avg_speed', 'max_speed', 'avg_acceleration', 'score', 'grade',
  'counted', 'speed_limit_coverage', 'route_summary', 'app_version',
];
const READING_COLUMNS = [
  'session_id', 'ts', 'speed', 'acceleration', 'latitude', 'longitude', 'accuracy', 'speed_limit',
];
const CHUNK = 500;

/** MySQL implementation of the database layer, built on a mysql2/promise pool. */
function makeRepo(pool) {
  return {
    async getUser(uid) {
      const [rows] = await pool.query(
        'SELECT user_id, name, email, consent_version, consent_at FROM users WHERE user_id = ?',
        [uid]
      );
      return rows[0] || null;
    },

    async upsertUser({ uid, name, email }) {
      await pool.query(
        `INSERT INTO users (user_id, name, email) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(VALUES(name), name),
           email = COALESCE(VALUES(email), email)`,
        [uid, name || null, email || null]
      );
    },

    async setConsent(uid, version, at) {
      await pool.query(
        'UPDATE users SET consent_version = ?, consent_at = ? WHERE user_id = ?',
        [version, at, uid]
      );
    },

    /** Saves a trip and its readings in one transaction. Returns false if the trip was already saved. */
    async insertTrip(session, readings) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        try {
          await conn.query(
            `INSERT INTO driving_sessions (${SESSION_COLUMNS.join(', ')}) VALUES (?)`,
            [SESSION_COLUMNS.map((c) => session[c])]
          );
        } catch (err) {
          if (err && err.code === 'ER_DUP_ENTRY') {
            await conn.rollback();
            return false; // already uploaded: safe to retry from the app
          }
          throw err;
        }
        for (let i = 0; i < readings.length; i += CHUNK) {
          const chunk = readings.slice(i, i + CHUNK).map((r) => READING_COLUMNS.map((c) => r[c]));
          await conn.query(
            `INSERT INTO driving_data (${READING_COLUMNS.join(', ')}) VALUES ?`,
            [chunk]
          );
        }
        await conn.commit();
        return true;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },

    async listTrips(uid, limit) {
      const [rows] = await pool.query(
        `SELECT ${SESSION_COLUMNS.join(', ')}, received_at FROM driving_sessions
         WHERE user_id = ? ORDER BY start_time DESC LIMIT ?`,
        [uid, limit]
      );
      return rows;
    },

    async getTrip(uid, clientId) {
      const [sessions] = await pool.query(
        `SELECT ${SESSION_COLUMNS.join(', ')}, received_at FROM driving_sessions
         WHERE user_id = ? AND client_session_id = ?`,
        [uid, clientId]
      );
      if (sessions.length === 0) return null;
      const [readings] = await pool.query(
        `SELECT ${READING_COLUMNS.join(', ')} FROM driving_data WHERE session_id = ? ORDER BY ts`,
        [sessions[0].session_id]
      );
      return { session: sessions[0], readings };
    },

    /** Deletes every trip for a user. Readings go too (ON DELETE CASCADE). */
    async deleteTrips(uid) {
      const [result] = await pool.query('DELETE FROM driving_sessions WHERE user_id = ?', [uid]);
      return result.affectedRows;
    },

    async ping() {
      await pool.query('SELECT 1');
    },
  };
}

module.exports = { makeRepo, SESSION_COLUMNS, READING_COLUMNS };
