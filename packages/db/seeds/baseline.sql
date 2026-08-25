-- CI gate #4 runs migrations against a copy of the database *that already has rows*.
-- A migration that only ever runs on an empty schema is not the migration that will
-- run in production. This file is that "already has rows" state.
INSERT INTO service_heartbeats (service_key, observed_at)
VALUES
  ('api',              '2026-08-20T09:00:00Z'),
  ('realtime-gateway', '2026-08-20T09:00:05Z')
ON CONFLICT (service_key) DO NOTHING;
