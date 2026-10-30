-- DevTrace schema v3 (Milestones 3-4): image annotations, redaction marker, review decisions.
--
-- Annotations are non-destructive overlays (highlight boxes with labels) stored as JSON on the
-- attachment. Redaction (Milestone 4) is destructive: regions are burned into the image file and
-- `redacted_at` records when that happened. Review decisions form an append-only audit trail.

ALTER TABLE attachments ADD COLUMN annotations_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(annotations_json) AND json_type(annotations_json) = 'array');

ALTER TABLE attachments ADD COLUMN redacted_at TEXT;

CREATE TABLE review_decisions (
    id            TEXT PRIMARY KEY NOT NULL,
    session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    event_id      TEXT REFERENCES events (id) ON DELETE SET NULL,
    decision      TEXT NOT NULL,
    comment       TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
    reviewer      TEXT NOT NULL DEFAULT '' CHECK (length(reviewer) <= 80),
    details_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
    created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX ix_review_decisions_session ON review_decisions (session_id, created_at);
CREATE INDEX ix_review_decisions_event ON review_decisions (event_id);
