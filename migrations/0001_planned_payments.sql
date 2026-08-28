CREATE TABLE IF NOT EXISTS planned_payments (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  category_id TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'yearly')),
  time_local TEXT NOT NULL,
  timezone TEXT NOT NULL,
  anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_reminder_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_planned_payments_user_due
  ON planned_payments (telegram_id, active, next_reminder_at);

CREATE INDEX IF NOT EXISTS idx_planned_payments_due
  ON planned_payments (active, next_reminder_at);

CREATE TABLE IF NOT EXISTS payment_reminders (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  occurrence_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed')),
  resolution TEXT
    CHECK (resolution IN ('paid', 'skipped', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (payment_id, occurrence_at),
  FOREIGN KEY (payment_id) REFERENCES planned_payments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_reminders_delivery
  ON payment_reminders (delivery_status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_payment_reminders_open
  ON payment_reminders (payment_id, resolution);
