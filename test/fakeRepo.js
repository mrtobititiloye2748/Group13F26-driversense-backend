'use strict';

// In-memory stand-in for src/repo.js so the handlers can be tested without MySQL.
function makeFakeRepo() {
  const users = new Map();
  const sessions = new Map();
  const readings = [];

  return {
    users,
    sessions,
    readings,
    async getUser(uid) {
      return users.get(uid) || null;
    },
    async upsertUser({ uid, name, email }) {
      const prev = users.get(uid) || { user_id: uid, consent_version: 0, consent_at: null };
      users.set(uid, { ...prev, name: name || prev.name || null, email: email || prev.email || null });
    },
    async setConsent(uid, version, at) {
      const u = users.get(uid);
      if (u) users.set(uid, { ...u, consent_version: version, consent_at: at });
    },
    async insertTrip(session, rows) {
      if (sessions.has(session.session_id)) return false;
      for (const s of sessions.values()) {
        if (s.user_id === session.user_id && s.client_session_id === session.client_session_id) return false;
      }
      sessions.set(session.session_id, { ...session, received_at: new Date() });
      readings.push(...rows);
      return true;
    },
    async listTrips(uid, limit) {
      return [...sessions.values()]
        .filter((s) => s.user_id === uid)
        .sort((a, b) => b.start_time - a.start_time)
        .slice(0, limit);
    },
    async getTrip(uid, clientId) {
      const s = [...sessions.values()].find((x) => x.user_id === uid && x.client_session_id === clientId);
      if (!s) return null;
      return { session: s, readings: readings.filter((r) => r.session_id === s.session_id) };
    },
    async deleteTrips(uid) {
      let n = 0;
      for (const [id, s] of sessions) {
        if (s.user_id === uid) {
          sessions.delete(id);
          n += 1;
          for (let i = readings.length - 1; i >= 0; i -= 1) {
            if (readings[i].session_id === id) readings.splice(i, 1);
          }
        }
      }
      return n;
    },
    async ping() {},
  };
}

module.exports = { makeFakeRepo };
