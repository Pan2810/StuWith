/* eslint-disable */
/**
 * Forward-only (spine, "Migration"). No `down` is exported on purpose: a rollback
 * path is a second, untested code path that only ever runs during an incident.
 *
 * Scope note: this migration creates INFRASTRUCTURE only. `users`, `coin_ledger`
 * and `audit_events` belong to Story 1.2 / 1.7 and must not appear here.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // pgvector ships inside the pinned Postgres image (pgvector/pgvector:0.8.6-pg18-trixie).
  // Enabling it here proves the running image really is that one; the first vector
  // column arrives with US-3.1.
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS vector`);

  // uuidv7() is native in PostgreSQL 18 — the spine's "UUIDv7 for every primary
  // key, sortable by time, does not leak volume" convention with no extension.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      id           uuid        PRIMARY KEY DEFAULT uuidv7(),
      service_key  text        NOT NULL,
      observed_at  timestamptz NOT NULL,
      recorded_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_heartbeats_service_key_key UNIQUE (service_key)
    )
  `);

  pgm.sql(`
    COMMENT ON TABLE service_heartbeats IS
      'Infrastructure liveness rows. Not a business table. Written by both processes; the only shared-write surface in Story 1.1.'
  `);
};
