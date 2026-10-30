-- DevTrace schema v6 (Milestone 8): reviewable, verifiable change records.
--
-- A change record keeps its evidence level (`assertion`): observed by DevTrace (for example a
-- watched configuration file changed), declared by a user, or verified with an explicit note
-- saying how the outcome was checked. Review (approve or reject, with a comment) is separate
-- from verification. `event_id` links the session step that documents the change.

ALTER TABLE change_records ADD COLUMN event_id TEXT REFERENCES events (id) ON DELETE SET NULL;
ALTER TABLE change_records ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE change_records ADD COLUMN review_comment TEXT NOT NULL DEFAULT ''
    CHECK (length(review_comment) <= 2000);
ALTER TABLE change_records ADD COLUMN reviewer TEXT NOT NULL DEFAULT '' CHECK (length(reviewer) <= 80);
ALTER TABLE change_records ADD COLUMN reviewed_at TEXT;
ALTER TABLE change_records ADD COLUMN verification_note TEXT NOT NULL DEFAULT ''
    CHECK (length(verification_note) <= 2000);
ALTER TABLE change_records ADD COLUMN verified_by TEXT NOT NULL DEFAULT '' CHECK (length(verified_by) <= 80);
ALTER TABLE change_records ADD COLUMN verified_at TEXT;

CREATE INDEX ix_change_records_event_id ON change_records (event_id);
