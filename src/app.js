'use strict';

const express = require('express');
const { makeHandlers } = require('./handlers');
const { requireUser } = require('./auth');

/**
 * Builds the Express app.
 *   repo          database layer (src/repo.js)
 *   verifyIdToken checks a Firebase ID token and returns its claims
 */
function createApp({ repo, verifyIdToken, devBypass = false }) {
  const app = express();
  const handlers = makeHandlers(repo);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' })); // a 1500-reading trip is roughly 200 KB

  // Lets the Expo web build call the API from the browser.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Debug-Uid');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.get('/health', async (req, res) => {
    try {
      await repo.ping();
      res.json({ ok: true, database: 'up' });
    } catch {
      res.status(503).json({ ok: false, database: 'down' });
    }
  });

  const auth = requireUser(verifyIdToken, { devBypass });
  const route = (handler) => async (req, res, next) => {
    try {
      const result = await handler({ user: req.user, body: req.body, query: req.query, params: req.params });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  };

  app.get('/api/consent', auth, route(handlers.getConsent));
  app.put('/api/consent', auth, route(handlers.putConsent));
  app.get('/api/trips', auth, route(handlers.listTrips));
  app.post('/api/trips', auth, route(handlers.postTrip));
  app.get('/api/trips/:id', auth, route(handlers.getTrip));
  app.delete('/api/trips', auth, route(handlers.deleteTrips));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'too_large', message: 'Trip is too large' });
    }
    if (err && (err.status === 400 || err.type === 'entity.parse.failed')) {
      return res.status(400).json({ error: 'bad_request', message: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  });

  return app;
}

module.exports = { createApp };
