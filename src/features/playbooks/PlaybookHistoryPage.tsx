import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeftRight, ArrowRight, Copy, Download, GitCompareArrows, History, RotateCcw, SearchX } from "lucide-react";

import {
  Button,
  ConfirmDialog,
  DiffView,
  EmptyState,
  Icon,
  Notice,
  Select,
  Spinner,
  Switch,
  Tabs,
  tabId,
  tabPanelId,
  useToast,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, toApiError, type PlaybookDetail, type VersionSnapshot } from "../../lib/api";
import { useResource } from "../../lib/hooks";
import { ExportDialog } from "./ExportDialog";
import { versionEntries, versionText, WORKING_COPY, workingSnapshot, type VersionEntry } from "./historyModel";
import styles from "./PlaybookHistoryPage.module.css";
import { CURRENT_VERSION } from "./playbookModel";
import { PlaybookReadView } from "./PlaybookReadView";

type View = "read" | "compare";

/** `/playbooks/:playbookId/history` — every version of a playbook: read, compare, restore, reuse. */
export function PlaybookHistoryPage() {
  const { playbookId = "" } = useParams();
  const navigate = useNavigate();
  const fetchPlaybook = useCallback(() => api.playbooks.get(playbookId), [playbookId]);
  const playbook = useResource(fetchPlaybook);

  if (playbook.data) return <HistoryWorkspace detail={playbook.data} />;
  const missing = playbook.error?.kind === "not_found" || playbook.error?.kind === "validation";
  return (
    <Page title="Version history" breadcrumbs={[{ label: "Playbooks", to: "/playbooks" }]}>
      <div className={styles.centered}>
        {missing ? (
          <EmptyState
            icon={SearchX}
            title="Playbook not found"
            description="It may have been deleted."
            actions={<Button onClick={() => navigate("/playbooks")}>Show all playbooks</Button>}
          />
        ) : playbook.error ? (
          <Notice
            tone="danger"
            role="alert"
            title="The version history could not be loaded"
            action={
              <Button size="sm" onClick={playbook.reload}>
                Retry
              </Button>
            }
          >
            {playbook.error.message}
          </Notice>
        ) : (
          <Spinner size={18} />
        )}
      </div>
    </Page>
  );
}

/** Loads the snapshot of one version (the working copy needs no request). */
function useVersionSnapshot(detail: PlaybookDetail, entry: VersionEntry | undefined) {
  const fetcher = useCallback(async (): Promise<VersionSnapshot | null> => {
    if (!entry) return null;
    if (entry.kind === "working") return workingSnapshot(detail);
    if (entry.kind === "revision") return (await api.playbooks.revision(detail.id, entry.id)).snapshot;
    return (await api.playbooks.restorePoint(detail.id, entry.id)).snapshot;
  }, [detail, entry]);
  return useResource(fetcher);
}

function HistoryWorkspace({ detail }: { detail: PlaybookDetail }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const entries = useMemo(() => versionEntries(detail), [detail]);
  const find = (id: string | null) => entries.find((entry) => entry.id === id);
  const newestRevision = entries.find((entry) => entry.kind === "revision");

  const selected = find(params.get("version")) ?? newestRevision ?? entries[0]!;
  const view: View = params.get("view") === "compare" ? "compare" : "read";
  const to = find(params.get("to")) ?? entries[0]!;
  const fallbackFrom = selected.id !== to.id ? selected : (entries.find((entry) => entry.id !== to.id) ?? to);
  const from = find(params.get("from")) ?? fallbackFrom;

  const update = (patch: Record<string, string>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const [restoring, setRestoring] = useState<VersionEntry | null>(null);
  const [exporting, setExporting] = useState<VersionEntry | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  const duplicate = async (entry: VersionEntry) => {
    setDuplicating(true);
    try {
      const copy = await api.playbooks.duplicate(detail.id, entry.kind === "revision" ? entry.id : null);
      toast.success("Playbook duplicated", `\u201c${copy.title}\u201d is a new draft with its own copies of the screenshots.`);
      navigate(`/playbooks/${copy.id}`);
    } catch (raw) {
      toast.error("The playbook could not be duplicated", toApiError(raw).message);
    } finally {
      setDuplicating(false);
    }
  };

  const crumbs = [
    { label: "Playbooks", to: "/playbooks" },
    { label: detail.title, to: `/playbooks/${detail.id}` },
  ];
  const revisions = entries.filter((entry) => entry.kind === "revision");
  const saved = entries.filter((entry) => entry.kind === "restorePoint");

  const entryButton = (entry: VersionEntry) => (
    <li key={entry.id}>
      <button
        type="button"
        className={styles.entry}
        aria-current={view === "read" && entry.id === selected.id ? "true" : undefined}
        onClick={() => update({ version: entry.id, view: "read" })}
      >
        <span className={styles.entryLabel}>{entry.label}</span>
        <span className={styles.entryDetail}>{entry.detail}</span>
        {entry.note && <span className={styles.entryNote}>{entry.note}</span>}
      </button>
    </li>
  );

  return (
    <Page
      title="Version history"
      breadcrumbs={crumbs}
      layout="fill"
      actions={
        <Button icon={ArrowLeftRight} onClick={() => update({ view: "compare" })} disabledReason={entries.length < 2 ? "There is only one version so far." : undefined}>
          Compare versions
        </Button>
      }
    >
      <div className={styles.workspace}>
        <nav className={styles.versions} aria-label="Versions">
          <ul className={styles.list}>{entryButton(entries[0]!)}</ul>
          <span className={styles.groupLabel}>Published revisions ({revisions.length})</span>
          {revisions.length === 0 ? (
            <p className={styles.hint}>Not published yet. Publishing records an immutable revision.</p>
          ) : (
            <ul className={styles.list}>{revisions.map(entryButton)}</ul>
          )}
          {saved.length > 0 && (
            <>
              <span className={styles.groupLabel}>Saved drafts ({saved.length})</span>
              <ul className={styles.list}>{saved.map(entryButton)}</ul>
              <p className={styles.hint}>Unpublished work that a restore replaced. Restore one to continue from it.</p>
            </>
          )}
        </nav>

        <section className={styles.main} aria-label="Selected version">
          <div className={styles.tabs}>
            <Tabs<View>
              label="Version history view"
              idPrefix="history"
              value={view}
              onChange={(next) => update({ view: next })}
              options={[
                { value: "read", label: "Read", icon: History },
                { value: "compare", label: "Compare", icon: GitCompareArrows },
              ]}
            />
          </div>
          <div className={styles.panel} role="tabpanel" id={tabPanelId("history", view)} aria-labelledby={tabId("history", view)}>
            {view === "read" ? (
              <ReadPanel
                key={selected.id}
                detail={detail}
                entry={selected}
                busy={duplicating}
                onRestore={() => setRestoring(selected)}
                onDuplicate={() => void duplicate(selected)}
                onExport={() => setExporting(selected)}
                onCompare={() => update({ view: "compare", from: selected.id, to: WORKING_COPY })}
              />
            ) : (
              <ComparePanel
                detail={detail}
                entries={entries}
                from={from}
                to={to}
                onChange={(patch) => update(patch)}
              />
            )}
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title={restoring ? `Restore ${restoring.label.toLowerCase()} as the draft?` : "Restore this version?"}
        confirmLabel="Restore as draft"
        onConfirm={async () => {
          if (!restoring) return;
          await api.playbooks.restore(detail.id, restoring.kind === "revision" ? { kind: "revision", id: restoring.id } : { kind: "restorePoint", id: restoring.id });
          toast.success(`${restoring.label} restored`, "The working copy is now a draft with its content.");
          navigate(`/playbooks/${detail.id}`);
        }}
      >
        <p>The working copy becomes a draft with the title, properties and content of this version.</p>
        <p>If the working copy has unpublished changes, they are kept as a saved draft in this history, so nothing is lost. Published revisions never change.</p>
      </ConfirmDialog>
      {exporting && (
        <ExportDialog
          key={exporting.id}
          open
          onClose={() => setExporting(null)}
          detail={detail}
          initialVersion={exporting.kind === "revision" ? exporting.id : CURRENT_VERSION}
          beforeExport={() => Promise.resolve(true)}
        />
      )}
    </Page>
  );
}

interface ReadPanelProps {
  detail: PlaybookDetail;
  entry: VersionEntry;
  busy: boolean;
  onRestore: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onCompare: () => void;
}

function ReadPanel({ detail, entry, busy, onRestore, onDuplicate, onExport, onCompare }: ReadPanelProps) {
  const snapshot = useVersionSnapshot(detail, entry);
  const assets = useMemo(() => new Map(detail.assets.map((asset) => [asset.id, asset])), [detail.assets]);
  const latest = detail.revisions[0];
  const superseded = entry.kind === "revision" && latest !== undefined && entry.revisionNumber !== latest.revisionNumber;
  const restoreBlocked =
    entry.kind === "working"
      ? "This is the working copy."
      : detail.status === "in_review"
        ? "The playbook is in review. Return it to draft before restoring another version."
        : undefined;
  const exportBlocked = entry.kind === "restorePoint" ? "Restore this saved draft first to export it." : undefined;
  const duplicateBlocked = entry.kind === "restorePoint" ? "Restore this saved draft first to duplicate it." : undefined;

  return (
    <>
      <div className={styles.panelHeader}>
        <div className={styles.headerText}>
          <span className={styles.headerTitle}>{entry.label}</span>
          <span className={styles.headerDetail}>{entry.detail}</span>
          {entry.kind === "revision" && entry.note && <span className={styles.headerNote}>{entry.note}</span>}
        </div>
        <div className={styles.headerActions}>
          {entry.kind !== "working" && (
            <Button icon={RotateCcw} onClick={onRestore} disabledReason={restoreBlocked}>
              Restore as draft…
            </Button>
          )}
          <Button icon={ArrowLeftRight} onClick={onCompare} disabledReason={entry.kind === "working" ? "Choose an older version to compare with the working copy." : undefined}>
            Compare with working copy
          </Button>
          <Button icon={Copy} onClick={onDuplicate} loading={busy} disabledReason={duplicateBlocked}>
            Duplicate
          </Button>
          <Button icon={Download} onClick={onExport} disabledReason={exportBlocked}>
            Export…
          </Button>
        </div>
      </div>
      {/* Focusable so the version can be scrolled with the keyboard. */}
      <div className={styles.scroll} role="region" aria-label={`${entry.label} content`} tabIndex={0}>
        {superseded && (
          <Notice tone="neutral" className={styles.notice} title="Superseded">
            Revision {latest.revisionNumber} is newer. This revision stays unchanged in the history.
          </Notice>
        )}
        {entry.kind === "restorePoint" && (
          <Notice tone="neutral" className={styles.notice} title="Saved draft">
            Unpublished work that was replaced when another version was restored. It was never published.
          </Notice>
        )}
        {snapshot.error ? (
          <Notice tone="danger" role="alert" className={styles.notice} title="This version could not be loaded">
            {snapshot.error.message}
          </Notice>
        ) : snapshot.data ? (
          <PlaybookReadView snapshot={snapshot.data} assets={assets} sessions={detail.sessions} label={entry.label} />
        ) : (
          <div className={styles.empty}>
            <Spinner size={18} />
          </div>
        )}
      </div>
    </>
  );
}

interface ComparePanelProps {
  detail: PlaybookDetail;
  entries: VersionEntry[];
  from: VersionEntry;
  to: VersionEntry;
  onChange: (patch: Record<string, string>) => void;
}

function ComparePanel({ detail, entries, from, to, onChange }: ComparePanelProps) {
  const [showAll, setShowAll] = useState(false);
  const before = useVersionSnapshot(detail, from);
  const after = useVersionSnapshot(detail, to);
  const assets = useMemo(() => new Map(detail.assets.map((asset) => [asset.id, asset])), [detail.assets]);
  const options = entries.map((entry) => ({ value: entry.id, label: entry.kind === "restorePoint" ? `${entry.label} \u00b7 ${entry.detail}` : entry.label }));
  const beforeText = useMemo(() => (before.data ? versionText(before.data, assets) : null), [before.data, assets]);
  const afterText = useMemo(() => (after.data ? versionText(after.data, assets) : null), [after.data, assets]);

  if (entries.length < 2) {
    return (
      <div className={styles.empty}>
        <EmptyState icon={GitCompareArrows} title="Nothing to compare yet" description="Publish a revision or keep editing; every published revision can be compared with the working copy." />
      </div>
    );
  }
  const error = before.error ?? after.error;
  return (
    <>
      <div className={styles.compareBar}>
        <div className={styles.compareSelect}>
          <Select label="From" options={options} value={from.id} onChange={(event) => onChange({ from: event.target.value })} />
        </div>
        <Icon icon={ArrowRight} size={16} className={styles.compareArrow} />
        <div className={styles.compareSelect}>
          <Select label="To" options={options} value={to.id} onChange={(event) => onChange({ to: event.target.value })} />
        </div>
        <div className={styles.compareSwitch}>
          <Switch label="Show unchanged lines" checked={showAll} onCheckedChange={setShowAll} />
        </div>
      </div>
      {/* Focusable so the comparison can be scrolled with the keyboard. */}
      <div className={styles.scroll} role="region" aria-label="Comparison" tabIndex={0}>
        {error ? (
          <Notice tone="danger" role="alert" className={styles.notice} title="A version could not be loaded">
            {error.message}
          </Notice>
        ) : beforeText !== null && afterText !== null ? (
          <div className={styles.diff}>
            <DiffView label={`${from.label} \u2192 ${to.label}`} before={beforeText} after={afterText} context={showAll ? undefined : 3} />
          </div>
        ) : (
          <div className={styles.empty}>
            <Spinner size={18} />
          </div>
        )}
      </div>
    </>
  );
}
