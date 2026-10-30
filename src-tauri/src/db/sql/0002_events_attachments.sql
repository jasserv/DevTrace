-- DevTrace schema v2 (Milestone 2): events and attachments.
--
-- Events are the ordered steps of a session. `source` records where content came from so
-- recorded facts (capture, Milestone 3) stay distinguishable from user-authored content
-- (manual, file, clipboard). Attachments are managed files stored under
-- <workspace>/attachments/<session_id>/<attachment_id>.<ext>; rows store only that relative
-- path. Deleting a session or event cascades to its rows; the application removes the files.

CREATE TABLE events (
    id             TEXT PRIMARY KEY NOT NULL,
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    position       INTEGER NOT NULL CHECK (position >= 0),
    occurred_at    TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    source         TEXT NOT NULL,
    title          TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description    TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    notes          TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
    code           TEXT NOT NULL DEFAULT '' CHECK (length(code) <= 20000),
    review_status  TEXT NOT NULL DEFAULT 'pending',
    metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX ix_events_session_position ON events (session_id, position);

CREATE TABLE attachments (
    id             TEXT PRIMARY KEY NOT NULL,
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    event_id       TEXT REFERENCES events (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    source         TEXT NOT NULL,
    original_name  TEXT NOT NULL DEFAULT '' CHECK (length(original_name) <= 255),
    relative_path  TEXT NOT NULL UNIQUE CHECK (length(relative_path) BETWEEN 1 AND 255),
    media_type     TEXT NOT NULL,
    byte_size      INTEGER NOT NULL CHECK (byte_size > 0),
    sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
    width          INTEGER CHECK (width IS NULL OR width > 0),
    height         INTEGER CHECK (height IS NULL OR height > 0),
    created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX ix_attachments_session ON attachments (session_id);
CREATE INDEX ix_attachments_event ON attachments (event_id);
