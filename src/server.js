'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const { createApp } = require('./app');
const { makeRepo } = require('./repo');
const { firebaseVerifier } = require('./auth');

const required = ['DB_HOST', 'DB_USER', 'DB_NAME', 'FIREBASE_PROJECT_ID'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing settings in .env: ${missing.join(', ')} (copy .env.example to .env)`);
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';
const devBypass = process.env.AUTH_DEV_BYPASS === 'true' && !isProduction;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
  connectionLimit: 10,
  timezone: 'Z', // store and read times as UTC
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
});

const app = createApp({
  repo: makeRepo(pool),
  verifyIdToken: firebaseVerifier(process.env.FIREBASE_PROJECT_ID),
  devBypass,
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`DriverSense API listening on http://localhost:${port}`);
  if (devBypass) console.warn('AUTH_DEV_BYPASS is on: X-Debug-Uid is accepted. Never use this in production.');
});
