-- Only needed if you already created the database from the first version of
-- schema.sql. A fresh database made from the current schema.sql already has
-- these columns. Run once:  mysql -u root -p driversense < migrations/001_trip_api.sql
USE driversense;

ALTER TABLE users
  ADD COLUMN consent_version INT NOT NULL DEFAULT 0 AFTER email,
  ADD COLUMN consent_at DATETIME(3) NULL AFTER consent_version;

ALTER TABLE driving_sessions
  ADD COLUMN client_session_id VARCHAR(64) NOT NULL AFTER user_id,
  ADD COLUMN avg_acceleration DOUBLE NULL AFTER max_speed,
  ADD COLUMN grade VARCHAR(16) NULL AFTER score,
  ADD COLUMN speed_limit_coverage DOUBLE NULL AFTER counted,
  ADD COLUMN app_version VARCHAR(32) NULL AFTER route_summary,
  ADD UNIQUE KEY uq_sessions_user_client (user_id, client_session_id);

ALTER TABLE driving_data
  ADD COLUMN speed_limit DOUBLE NULL AFTER accuracy;
