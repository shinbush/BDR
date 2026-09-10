-- Additive migration: preserve payment IDs, open reminders and existing cadences.
-- interval_days overrides the legacy cadence for fixed-day schedules.
ALTER TABLE planned_payments ADD COLUMN interval_days INTEGER
  CHECK (interval_days IS NULL OR interval_days IN (1, 15));
