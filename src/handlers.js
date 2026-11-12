'use strict';

const { validateTrip, toRows, fromSessionRow, ValidationError } = require('./trips');

// Each handler takes { user, body, query } and returns { status, body }.
// `user` is the verified Firebase user: { uid, name, email }.
// `repo` is the database layer (src/repo.js, or an in-memory fake in tests).
// Keeping Express out of here lets the logic be tested without a server.

function makeHandlers(repo) {
  return {
    async getConsent({ user }) {
      const row = await repo.getUser(user.uid);
      return {
        status: 200,
        body: {
          consentVersion: row ? row.consent_version : 0,
          consentAt: row && row.consent_at ? new Date(row.consent_at).getTime() : null,
        },
      };
    },

    async putConsent({ user, body }) {
      const version = body && body.version;
      if (!Number.isInteger(version) || version < 1 || version > 1000) {
        throw new ValidationError('version must be a whole number from 1 to 1000');
      }
      await repo.upsertUser(user);
      await repo.setConsent(user.uid, version, new Date());
      return { status: 200, body: { consentVersion: version } };
    },

    async postTrip({ user, body }) {
      const trip = validateTrip(body);
      const consent = await repo.getUser(user.uid);
      if (!consent || consent.consent_version < 1) {
        return {
          status: 403,
          body: { error: 'consent_required', message: 'Agree to data upload in the app before sending trips.' },
        };
      }
      await repo.upsertUser(user);
      const { session, readings } = toRows(user.uid, trip);
      const created = await repo.insertTrip(session, readings);
      return {
        status: created ? 201 : 200,
        body: { id: trip.id, created, counted: Boolean(session.counted), readings: readings.length },
      };
    },

    async listTrips({ user, query }) {
      let limit = Number.parseInt((query && query.limit) || '50', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      limit = Math.min(limit, 200);
      const rows = await repo.listTrips(user.uid, limit);
      return { status: 200, body: { trips: rows.map(fromSessionRow) } };
    },

    async getTrip({ user, params }) {
      const found = await repo.getTrip(user.uid, params.id);
      if (!found) return { status: 404, body: { error: 'not_found' } };
      return {
        status: 200,
        body: {
          ...fromSessionRow(found.session),
          samples: found.readings.map((r) => ({
            timestamp: new Date(r.ts).getTime(),
            latitude: r.latitude,
            longitude: r.longitude,
            speedKmh: r.speed,
            accelerationMs2: r.acceleration,
            speedLimitKmh: r.speed_limit,
          })),
        },
      };
    },

    async deleteTrips({ user }) {
      const deleted = await repo.deleteTrips(user.uid);
      return { status: 200, body: { deleted } };
    },
  };
}

module.exports = { makeHandlers };
