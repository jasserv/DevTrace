-- DevTrace schema v5 (Milestone 7): version history.
--
-- Restoring a published revision replaces the working copy of a playbook. So that unpublished
-- work is never lost, the replaced working copy is kept as a restore point (same snapshot shape
-- as a revision) and can be restored in turn. Evidence copies referenced by a restore point are
-- kept like those referenced by revisions.
--
-- `restored_from_revision` tells the editor that the current draft started from an older
-- revision; publishing clears it. `based_on_*` records where a duplicated playbook came from.

ALTER TABLE playbooks ADD COLUMN restored_from_revision INTEGER
    CHECK (restored_from_revision IS NULL OR restored_from_revision >= 1);
ALTER TABLE playbooks ADD COLUMN based_on_playbook_id TEXT REFERENCES playbooks (id) ON DELETE SET NULL;
ALTER TABLE playbooks ADD COLUMN based_on_revision INTEGER
    CHECK (based_on_revision IS NULL OR based_on_revision >= 1);

CREATE TABLE playbook_restore_points (
    id                        TEXT PRIMARY KEY NOT NULL,
    playbook_id               TEXT NOT NULL REFERENCES playbooks (id) ON DELETE CASCADE,
    -- The revision (or restore point) whose content replaced this working copy.
    replaced_by               TEXT NOT NULL CHECK (length(replaced_by) BETWEEN 1 AND 120),
    title                     TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    snapshot_json             TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    created_at                TEXT NOT NULL
) STRICT;

CREATE INDEX ix_playbook_restore_points_playbook ON playbook_restore_points (playbook_id, created_at);
