-- DriverSense database schema (MySQL 8)
CREATE DATABASE IF NOT EXISTS driversense
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE driversense;

-- One row per app user. user_id is the Firebase Auth uid.
CREATE TABLE IF NOT EXISTS users (
  user_id          VARCHAR(128) PRIMARY KEY,
  name             VARCHAR(120) NULL,
  email            VARCHAR(255) NULL,
  consent_version  INT NOT NULL DEFAULT 0 COMMENT 'version of the data-upload consent the user agreed to; 0 = not agreed',
  consent_at       DATETIME(3) NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- One row per driving session (trip).
-- session_id is a SHA-256 of "<user_id>:<client_session_id>", so the same trip
-- uploaded twice maps to the same row and two users can never collide.
CREATE TABLE IF NOT EXISTS driving_sessions (
  session_id            VARCHAR(64) PRIMARY KEY,
  user_id               VARCHAR(128) NOT NULL,
  client_session_id     VARCHAR(64) NOT NULL COMMENT 'id the app gave the trip, e.g. session-1731440000000',
  start_time            DATETIME(3) NOT NULL,
  end_time              DATETIME(3) NOT NULL,
  duration_sec          INT NOT NULL,
  total_distance        DOUBLE NOT NULL COMMENT 'km',
  avg_speed             DOUBLE NOT NULL COMMENT 'km/h',
  max_speed             DOUBLE NOT NULL COMMENT 'km/h',
  avg_acceleration      DOUBLE NULL COMMENT 'm/s^2, average absolute value',
  score                 DOUBLE NULL,
  grade                 VARCHAR(16) NULL,
  counted               TINYINT(1) NOT NULL DEFAULT 0,
  speed_limit_coverage  DOUBLE NULL COMMENT 'share of readings (0-1) matched to a road speed limit',
  route_summary         JSON NULL,
  app_version           VARCHAR(32) NULL,
  received_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_session_user FOREIGN KEY (user_id)
    REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE KEY uq_sessions_user_client (user_id, client_session_id),
  INDEX idx_sessions_user_start (user_id, start_time)
);

-- One row per GPS reading inside a session.
CREATE TABLE IF NOT EXISTS driving_data (
  data_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id    VARCHAR(64) NOT NULL,
  ts            DATETIME(3) NOT NULL,
  speed         DOUBLE NOT NULL COMMENT 'km/h',
  acceleration  DOUBLE NULL COMMENT 'm/s^2',
  latitude      DOUBLE NOT NULL,
  longitude     DOUBLE NOT NULL,
  accuracy      DOUBLE NULL COMMENT 'metres',
  speed_limit   DOUBLE NULL COMMENT 'km/h, road speed limit at this point if known',
  CONSTRAINT fk_data_session FOREIGN KEY (session_id)
    REFERENCES driving_sessions(session_id) ON DELETE CASCADE,
  INDEX idx_data_session_ts (session_id, ts)
);
