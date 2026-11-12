# DriverSense backend

Node.js + Express API that receives finished trips from the DriverSense app and stores them in MySQL.
Group 13, SENG71000 F26 Sec 2.

## Setup

1. Install Node.js 20+ and MySQL 8.
2. Create the database:
   ```
   mysql -u root -p < schema.sql
   ```
   If you already created it from the first version of `schema.sql`, run `migrations/001_trip_api.sql` once instead.
3. Install packages and configure:
   ```
   npm install
   cp .env.example .env
   ```
   Fill in the MySQL login and `FIREBASE_PROJECT_ID` (the same project id as the app's `EXPO_PUBLIC_FIREBASE_PROJECT_ID`).
4. Start it:
   ```
   npm start
   ```
   Check http://localhost:3000/health. It should show `{"ok":true,"database":"up"}`.
5. Run the tests (no database needed):
   ```
   npm test
   ```

## Connecting the app

In the app's `.env`, add the API address and restart Expo with `npx expo start -c`:

```
EXPO_PUBLIC_API_URL=http://192.168.1.50:3000
```

Use your computer's local network IP (run `ipconfig` on Windows), not `localhost`. On a real phone, `localhost` means the phone itself. Phone and computer must be on the same Wi-Fi.

## Authentication

Every `/api` request needs the signed-in user's Firebase ID token:

```
Authorization: Bearer <token>
```

The app gets it from `auth.currentUser.getIdToken()`. The server checks it with the Firebase Admin SDK, which only needs the project id. Users with an unverified email are refused.

**Postman testing:** set `AUTH_DEV_BYPASS=true` in `.env` and send `X-Debug-Uid: test-user` instead of a token. This is ignored when `NODE_ENV=production`.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Server and database status (no login needed) |
| GET | `/api/consent` | The user's data-upload consent: `{ consentVersion, consentAt }` |
| PUT | `/api/consent` | Record consent. Body: `{ "version": 1 }` |
| POST | `/api/trips` | Upload one finished trip (see below) |
| GET | `/api/trips?limit=50` | The user's trips, newest first (max 200) |
| GET | `/api/trips/:id` | One trip with its GPS readings |
| DELETE | `/api/trips` | Delete all of the user's trips |

### Uploading a trip

`POST /api/trips` takes the trip as the app stores it (`StoredSession` in `sessionUtils.ts`):

```json
{
  "id": "session-1731440000000",
  "startedAt": 1731440000000,
  "endedAt": 1731440600000,
  "durationSec": 600,
  "distanceKm": 5.2,
  "averageSpeedKmh": 31,
  "maxSpeedKmh": 49,
  "averageAccelerationMs2": 0.5,
  "score": 88,
  "grade": "Excellent",
  "speedLimitCoverage": 0.5,
  "appVersion": "1.0.0",
  "samples": [
    { "timestamp": 1731440000000, "latitude": 43.45, "longitude": -80.49,
      "speedKmh": 40, "accelerationMs2": 0.5, "speedLimitKmh": 50 }
  ]
}
```

Responses:

- **201** `{ id, created: true, counted, readings }`: the trip was saved.
- **200** `{ created: false }`: the trip was already saved. Retrying is safe.
- **403** `consent_required`: the user hasn't agreed to upload yet.
- **400**: a field is missing or out of range. The message says which one.

The user must have given consent (`PUT /api/consent`) first. `counted` follows the app's rules: at least 5 minutes, 2 km and an average of 8 km/h.

## How data is stored

- `users`: one row per Firebase user, plus their consent version.
- `driving_sessions`: one row per trip. `session_id` is a SHA-256 of `<uid>:<app trip id>`, so a re-sent trip maps to the same row, and two users can never collide.
- `driving_data`: one row per GPS reading (up to 1,500 per trip from the app), inserted in the same transaction as the trip.

Deleting a user's trips removes their readings too (`ON DELETE CASCADE`).

## Code layout

```
src/server.js    reads .env, creates the MySQL pool, starts Express
src/app.js       Express routes and error handling
src/auth.js      Firebase ID token check
src/handlers.js  request logic (no Express, so it can be tested)
src/repo.js      MySQL queries
src/trips.js     trip validation, scoring eligibility, row mapping
test/            tests using an in-memory database
```
