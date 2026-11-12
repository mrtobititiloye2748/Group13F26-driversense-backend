'use strict';

const crypto = require('node:crypto');

// Same rules the app uses (sessionUtils.ts getEligibility), so the server
// agrees with the phone about which trips count toward the overall score.
const MIN_COUNTED_DURATION_SEC = 5 * 60;
const MIN_COUNTED_DISTANCE_KM = 2;
const MIN_COUNTED_AVG_SPEED_KMH = 8;

const MAX_SAMPLES = 20000; // the app keeps at most 1500 per trip; this is a safety cap
const GRADES = ['Excellent', 'Good', 'Fair', 'Poor'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function num(obj, key, { min = -Infinity, max = Infinity, optional = false } = {}) {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new ValidationError(`${key} is required`);
  }
  if (!isNum(v)) throw new ValidationError(`${key} must be a number`);
  if (v < min || v > max) throw new ValidationError(`${key} must be between ${min} and ${max}`);
  return v;
}

function isCounted({ durationSec, distanceKm, averageSpeedKmh }) {
  return (
    durationSec >= MIN_COUNTED_DURATION_SEC &&
    distanceKm >= MIN_COUNTED_DISTANCE_KM &&
    averageSpeedKmh >= MIN_COUNTED_AVG_SPEED_KMH
  );
}

/** Checks a trip sent by the app and returns a clean copy. Throws ValidationError. */
function validateTrip(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Body must be a JSON object');
  }

  const id = body.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    throw new ValidationError('id must be a string of 1 to 64 characters');
  }

  const startedAt = num(body, 'startedAt', { min: 0 });
  const endedAt = num(body, 'endedAt', { min: 0 });
  if (endedAt < startedAt) throw new ValidationError('endedAt must not be before startedAt');

  const trip = {
    id,
    startedAt,
    endedAt,
    durationSec: Math.round(num(body, 'durationSec', { min: 0, max: 7 * 24 * 3600 })),
    distanceKm: num(body, 'distanceKm', { min: 0, max: 10000 }),
    averageSpeedKmh: num(body, 'averageSpeedKmh', { min: 0, max: 500 }),
    maxSpeedKmh: num(body, 'maxSpeedKmh', { min: 0, max: 500 }),
    averageAccelerationMs2: num(body, 'averageAccelerationMs2', { min: 0, max: 100, optional: true }),
    score: num(body, 'score', { min: 0, max: 100, optional: true }),
    grade: null,
    speedLimitCoverage: num(body, 'speedLimitCoverage', { min: 0, max: 1, optional: true }),
    appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 32) : null,
    samples: [],
  };

  if (body.grade !== undefined && body.grade !== null) {
    if (!GRADES.includes(body.grade)) {
      throw new ValidationError(`grade must be one of ${GRADES.join(', ')}`);
    }
    trip.grade = body.grade;
  }

  const samples = body.samples === undefined ? [] : body.samples;
  if (!Array.isArray(samples)) throw new ValidationError('samples must be an array');
  if (samples.length > MAX_SAMPLES) {
    throw new ValidationError(`samples must have at most ${MAX_SAMPLES} readings`);
  }
  trip.samples = samples.map((s, i) => {
    if (!s || typeof s !== 'object') throw new ValidationError(`samples[${i}] must be an object`);
    try {
      return {
        timestamp: num(s, 'timestamp', { min: 0 }),
        latitude: num(s, 'latitude', { min: -90, max: 90 }),
        longitude: num(s, 'longitude', { min: -180, max: 180 }),
        speedKmh: num(s, 'speedKmh', { min: 0, max: 500 }),
        accelerationMs2: num(s, 'accelerationMs2', { optional: true }),
        speedLimitKmh: num(s, 'speedLimitKmh', { min: 0, max: 300, optional: true }),
        accuracy: num(s, 'accuracy', { min: 0, optional: true }),
      };
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(`samples[${i}].${err.message}`);
      throw err;
    }
  });

  return trip;
}

/** Server-side primary key: the same user + trip always maps to the same id. */
function serverSessionId(userId, clientId) {
  return crypto.createHash('sha256').update(`${userId}:${clientId}`).digest('hex');
}

function routeSummary(samples) {
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    start: { latitude: first.latitude, longitude: first.longitude },
    end: { latitude: last.latitude, longitude: last.longitude },
    points: samples.length,
  };
}

/** Turns a validated trip into the rows stored in driving_sessions and driving_data. */
function toRows(userId, trip) {
  const sessionId = serverSessionId(userId, trip.id);
  const summary = routeSummary(trip.samples);
  const session = {
    session_id: sessionId,
    user_id: userId,
    client_session_id: trip.id,
    start_time: new Date(trip.startedAt),
    end_time: new Date(trip.endedAt),
    duration_sec: trip.durationSec,
    total_distance: trip.distanceKm,
    avg_speed: trip.averageSpeedKmh,
    max_speed: trip.maxSpeedKmh,
    avg_acceleration: trip.averageAccelerationMs2,
    score: trip.score,
    grade: trip.grade,
    counted: isCounted(trip) ? 1 : 0,
    speed_limit_coverage: trip.speedLimitCoverage,
    route_summary: summary === null ? null : JSON.stringify(summary),
    app_version: trip.appVersion,
  };
  const readings = trip.samples.map((s) => ({
    session_id: sessionId,
    ts: new Date(s.timestamp),
    speed: s.speedKmh,
    acceleration: s.accelerationMs2,
    latitude: s.latitude,
    longitude: s.longitude,
    accuracy: s.accuracy,
    speed_limit: s.speedLimitKmh,
  }));
  return { session, readings };
}

/** Shapes a driving_sessions row the way the app names things. */
function fromSessionRow(row) {
  const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  return {
    id: row.client_session_id,
    startedAt: toMs(row.start_time),
    endedAt: toMs(row.end_time),
    durationSec: row.duration_sec,
    distanceKm: row.total_distance,
    averageSpeedKmh: row.avg_speed,
    maxSpeedKmh: row.max_speed,
    averageAccelerationMs2: row.avg_acceleration,
    score: row.score,
    grade: row.grade,
    counted: Boolean(row.counted),
    speedLimitCoverage: row.speed_limit_coverage,
    receivedAt: row.received_at ? toMs(row.received_at) : null,
  };
}

module.exports = {
  ValidationError,
  validateTrip,
  isCounted,
  serverSessionId,
  toRows,
  fromSessionRow,
  MIN_COUNTED_DURATION_SEC,
  MIN_COUNTED_DISTANCE_KM,
  MIN_COUNTED_AVG_SPEED_KMH,
};
