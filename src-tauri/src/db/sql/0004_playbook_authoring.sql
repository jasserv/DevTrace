-- DevTrace schema v4 (Milestone 5): playbook content, evidence copies and revisions.
--
-- `content_json` holds the playbook document (purpose, scope, prerequisites, permissions,
-- numbered steps, verification, warnings, troubleshooting, rollback). Every item records its
-- origin, so content copied from reviewed session steps stays distinguishable from text written
-- in the playbook.
--
-- Evidence used by a playbook is copied into <workspace>/playbook-assets/<playbook_id>/, so a
-- playbook (and its published revisions) stays complete when a session is deleted. Copies keep a
-- link to the attachment they came from; redacting that attachment redacts the copies too.
--
-- Published revisions are immutable snapshots of metadata and content.

ALTER TABLE playbooks ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(content_json) AND json_type(content_json) = 'object');

-- Set when the playbook is known to be out of date (Milestone 7), with an explanation.
ALTER TABLE playbooks ADD COLUMN outdated_at TEXT;
ALTER TABLE playbooks ADD COLUMN outdated_note TEXT NOT NULL DEFAULT '' CHECK (length(outdated_note) <= 2000);

CREATE TABLE playbook_assets (
    id                    TEXT PRIMARY KEY NOT NULL,
    playbook_id           TEXT NOT NULL REFERENCES playbooks (id) ON DELETE CASCADE,
    source_attachment_id  TEXT REFERENCES attachments (id) ON DELETE SET NULL,
    source_event_id       TEXT REFERENCES events (id) ON DELETE SET NULL,
    relative_path         TEXT NOT NULL UNIQUE CHECK (length(relative_path) BETWEEN 1 AND 255),
    media_type            TEXT NOT NULL,
    byte_size             INTEGER NOT NULL CHECK (byte_size > 0),
    sha256                TEXT NOT NULL CHECK (length(sha256) = 64),
    width                 INTEGER CHECK (width IS NULL OR width > 0),
    height                INTEGER CHECK (height IS NULL OR height > 0),
    annotations_json      TEXT NOT NULL DEFAULT '[]'
                          CHECK (json_valid(annotations_json) AND json_type(annotations_json) = 'array'),
    redacted_at           TEXT,
    created_at            TEXT NOT NULL
) STRICT;

CREATE INDEX ix_playbook_assets_playbook ON playbook_assets (playbook_id);
CREATE INDEX ix_playbook_assets_source ON playbook_assets (source_attachment_id);

CREATE TABLE playbook_revisions (
    id               TEXT PRIMARY KEY NOT NULL,
    playbook_id      TEXT NOT NULL REFERENCES playbooks (id) ON DELETE CASCADE,
    revision_number  INTEGER NOT NULL CHECK (revision_number >= 1),
    title            TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    snapshot_json    TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    note             TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    author           TEXT NOT NULL DEFAULT '' CHECK (length(author) <= 80),
    created_at       TEXT NOT NULL,
    UNIQUE (playbook_id, revision_number)
) STRICT;
