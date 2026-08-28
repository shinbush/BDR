-- The first production database was bootstrapped from schema.sql before
-- migrations were introduced. Keep this idempotent so both existing and new
-- environments have the table used by /api/state.
CREATE TABLE IF NOT EXISTS user_finance (
  telegram_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  financial_data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
