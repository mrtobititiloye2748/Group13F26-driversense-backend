'use strict';

/**
 * Express middleware that requires a Firebase ID token:
 *   Authorization: Bearer <token from auth.currentUser.getIdToken()>
 * On success it sets req.user = { uid, name, email }.
 *
 * `verifyIdToken` is injected so tests (and local Postman testing) can swap it out.
 */
function requireUser(verifyIdToken, { devBypass = false } = {}) {
  return async (req, res, next) => {
    // Local testing only (e.g. Postman): send "X-Debug-Uid: some-user".
    // Turned on with AUTH_DEV_BYPASS=true and refused when NODE_ENV=production.
    if (devBypass && req.get('X-Debug-Uid')) {
      req.user = { uid: req.get('X-Debug-Uid'), name: 'Debug User', email: null };
      return next();
    }

    const header = req.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing Bearer token' });
    }
    try {
      const decoded = await verifyIdToken(match[1]);
      if (decoded.email && decoded.email_verified === false) {
        return res.status(403).json({ error: 'email_not_verified', message: 'Verify your email first' });
      }
      req.user = { uid: decoded.uid, name: decoded.name || null, email: decoded.email || null };
      return next();
    } catch {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
    }
  };
}

/** Real token check using the Firebase Admin SDK. Only the project id is needed to verify tokens. */
function firebaseVerifier(projectId) {
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) admin.initializeApp({ projectId });
  return (token) => admin.auth().verifyIdToken(token);
}

module.exports = { requireUser, firebaseVerifier };
