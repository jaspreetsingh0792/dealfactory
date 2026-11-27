-- Opt-in home memory for a signed-in account. Apply after 0001:
--   npx wrangler d1 execute dealfactory-accounts --remote --file=ops/d1/0002_user_state.sql

CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
