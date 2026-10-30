import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowUp, CalendarX2, CircleCheck, Copy, Download, Ellipsis, FileCheck2, History, Plus, RotateCcw, SearchX, Send, Trash2, X } from "lucide-react";

import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Inspector,
  InspectorSection,
  Menu,
  Notice,
  PropertyList,
  Select,
  Spinner,
  StatusBadge,
  TextArea,
  TextField,
  useToast,
  type MenuEntry,
  type SelectOption,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, toApiError, type ListItem, type PlaybookAsset, type PlaybookDetail, type PlaybookStatus, type PlaybookStep } from "../../lib/api";
import { cx } from "../../lib/cx";
import { formatDateTime, formatTime, pluralize } from "../../lib/format";
import { useAutosave, useResource } from "../../lib/hooks";
import { playbookStatus } from "../../lib/status";
import { ExportDialog } from "./ExportDialog";
import { PlaybookImage } from "./PlaybookImage";
import {
  CLOSING_SECTIONS,
  draftOf,
  editItem,
  editStep,
  LIST_SECTIONS,
  moveBy,
  newItem,
  newStep,
  ORIGIN_LABELS,
  publishBlocker,
  sourceText,
  type ListSectionKey,
  type PlaybookDraft,
} from "./playbookModel";
import styles from "./PlaybookPage.module.css";

const CRUMBS = [{ label: "Playbooks", to: "/playbooks" }];

/** `/playbooks/:playbookId` — the playbook document editor. */
export function PlaybookPage() {
  const { playbookId = "" } = useParams();
  const navigate = useNavigate();
  const fetchPlaybook = useCallback(() => api.playbooks.get(playbookId), [playbookId]);
  const playbook = useResource(fetchPlaybook);

  if (playbook.data) {
    // Remount when the status changes so the editor starts from the saved document.
    return <PlaybookWorkspace key={`${playbook.data.id}:${playbook.data.status}`} detail={playbook.data} reload={playbook.reload} />;
  }
  const missing = playbook.error?.kind === "not_found" || playbook.error?.kind === "validation";
  return (
    <Page title={missing ? "Playbook not found" : playbook.error ? "Playbook unavailable" : "Loading playbook\u2026"} breadcrumbs={CRUMBS}>
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
            title="The playbook could not be loaded"
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

function OriginTag({ origin }: { origin: ListItem["origin"] }) {
  if (origin === "authored") return null;
  return <span className={cx(styles.origin, origin === "edited" && styles.originEdited)}>{ORIGIN_LABELS[origin]}</span>;
}

interface WorkspaceProps {
  detail: PlaybookDetail;
  reload: () => void;
}

function PlaybookWorkspace({ detail, reload }: WorkspaceProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useResource(api.projects.list);
  const [draft, setDraft] = useState<PlaybookDraft>(() => draftOf(detail));
  const [busy, setBusy] = useState<PlaybookStatus | "delete" | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [markingOutdated, setMarkingOutdated] = useState(false);
  const [outdatedNote, setOutdatedNote] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const editable = detail.status === "draft";

  const initial = useMemo(() => JSON.stringify(draftOf(detail)), [detail]);
  const save = useCallback(
    async (value: string) => {
      const parsed = JSON.parse(value) as PlaybookDraft;
      const saved = await api.playbooks.save(detail.id, parsed.input, parsed.content);
      return saved.updatedAt;
    },
    [detail.id],
  );
  const autosave = useAutosave(JSON.stringify(draft), initial, save, {
    delay: 1000,
    onBackgroundError: (error) => toast.error("The playbook was not saved", error.message),
  });

  const assets = useMemo(() => new Map(detail.assets.map((asset) => [asset.id, asset])), [detail.assets]);
  const blocker = publishBlocker(draft.content);
  const setInput = (patch: Partial<PlaybookDraft["input"]>) => setDraft((current) => ({ ...current, input: { ...current.input, ...patch } }));
  const setContent = (patch: Partial<PlaybookDraft["content"]>) => setDraft((current) => ({ ...current, content: { ...current.content, ...patch } }));
  const setSteps = (change: (steps: PlaybookStep[]) => PlaybookStep[]) =>
    setDraft((current) => ({ ...current, content: { ...current.content, steps: change(current.content.steps) } }));
  const setList = (key: ListSectionKey, change: (items: ListItem[]) => ListItem[]) =>
    setDraft((current) => ({ ...current, content: { ...current.content, [key]: change(current.content[key]) } }));

  const changeStatus = async (status: PlaybookStatus, note = "") => {
    setBusy(status);
    try {
      if (editable && !(await autosave.saveNow())) {
        toast.error("Save the playbook first", "The latest changes could not be saved. Fix the problem shown in the toolbar, then try again.");
        return false;
      }
      await api.playbooks.setStatus(detail.id, status, note);
      const messages: Record<PlaybookStatus, [string, string]> = {
        draft: ["Back to draft", "The playbook can be edited again."],
        in_review: ["Submitted for review", "Editing is locked until it is published or returned to draft."],
        published: ["Playbook published", "An immutable revision was recorded."],
      };
      toast.success(...messages[status]);
      reload();
      return true;
    } catch (raw) {
      toast.error("The status could not be changed", toApiError(raw).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveText =
    autosave.state === "saving"
      ? "Saving\u2026"
      : autosave.state === "error"
        ? `Not saved: ${autosave.error?.message ?? "unknown error"}`
        : autosave.savedAt
          ? `Saved at ${formatTime(autosave.savedAt)}`
          : editable
            ? "Changes save automatically"
            : "Read-only";

  const markCurrent = async () => {
    try {
      await api.playbooks.setOutdated(detail.id, false);
      toast.success("Marked as current", "The out-of-date notice was removed.");
      reload();
    } catch (raw) {
      toast.error("The playbook could not be updated", toApiError(raw).message);
    }
  };

  const duplicate = async () => {
    setDuplicating(true);
    try {
      if (editable && !(await autosave.saveNow())) {
        toast.error("Save the playbook first", "The latest changes could not be saved. Fix the problem shown in the toolbar, then try again.");
        return;
      }
      const copy = await api.playbooks.duplicate(detail.id);
      toast.success("Playbook duplicated", `\u201c${copy.title}\u201d is a new draft with its own copies of the screenshots.`);
      navigate(`/playbooks/${copy.id}`);
    } catch (raw) {
      toast.error("The playbook could not be duplicated", toApiError(raw).message);
    } finally {
      setDuplicating(false);
    }
  };

  const notPublished = "Only published procedures can be marked out of date.";
  const menuEntries: MenuEntry[] = [
    { id: "history", label: "Version history", icon: History, onSelect: () => navigate(`/playbooks/${detail.id}/history`) },
    {
      id: "duplicate",
      label: "Duplicate as new playbook",
      icon: Copy,
      disabled: duplicating,
      onSelect: () => void duplicate(),
    },
    detail.outdatedAt
      ? { id: "current", label: "Mark as current", icon: CircleCheck, onSelect: () => void markCurrent() }
      : {
          id: "outdated",
          label: "Mark as out of date\u2026",
          icon: CalendarX2,
          disabled: detail.revisions.length === 0,
          description: detail.revisions.length === 0 ? notPublished : undefined,
          onSelect: () => setMarkingOutdated(true),
        },
    { type: "separator", id: "separator" },
    { id: "delete", label: "Delete playbook\u2026", icon: Trash2, tone: "danger", onSelect: () => setDeleting(true) },
  ];

  const actions = (
    <>
      <span className={cx(styles.saveState, autosave.state === "error" && styles.saveError)} role="status">
        {saveText}
      </span>
      {autosave.state === "error" && (
        <Button size="sm" onClick={autosave.flush}>
          Retry
        </Button>
      )}
      <Button icon={History} onClick={() => navigate(`/playbooks/${detail.id}/history`)}>
        History
      </Button>
      <Button icon={Download} onClick={() => setExporting(true)}>
        Export…
      </Button>
      {detail.status === "draft" && (
        <Button icon={Send} loading={busy === "in_review"} disabledReason={blocker} onClick={() => void changeStatus("in_review")}>
          Submit for review
        </Button>
      )}
      {detail.status === "in_review" && (
        <Button icon={RotateCcw} loading={busy === "draft"} onClick={() => void changeStatus("draft")}>
          Return to draft
        </Button>
      )}
      {detail.status !== "published" ? (
        <Button variant="primary" icon={FileCheck2} disabledReason={blocker} onClick={() => setPublishing(true)}>
          Publish…
        </Button>
      ) : (
        <Button variant="primary" icon={RotateCcw} loading={busy === "draft"} onClick={() => void changeStatus("draft")}>
          Edit as new draft
        </Button>
      )}
      <Menu
        label="Playbook actions"
        align="end"
        entries={menuEntries}
        renderTrigger={(props) => <IconButton {...props} icon={Ellipsis} label="More playbook actions" />}
      />
    </>
  );

  const projectOptions: SelectOption[] = [
    { value: "", label: "Unassigned" },
    ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
  ];

  return (
    <Page title={draft.input.title || "Untitled playbook"} breadcrumbs={CRUMBS} layout="fill" actions={actions}>
      <div className={styles.workspace}>
        <div className={styles.documentScroll}>
          <article className={styles.document} aria-label="Playbook document">
            <div className={styles.statusRow}>
              <StatusBadge status={playbookStatus[detail.status]} />
              {detail.revisions[0] && (
                <span className={styles.muted}>
                  Revision {detail.revisions[0].revisionNumber} published {formatDateTime(detail.revisions[0].createdAt)}
                </span>
              )}
            </div>
            {detail.outdatedAt && (
              <Notice
                tone="warning"
                className={styles.notice}
                title={`Marked out of date on ${formatDateTime(detail.outdatedAt)}`}
                action={
                  <Button size="sm" onClick={() => void markCurrent()}>
                    Mark as current
                  </Button>
                }
              >
                {detail.outdatedNote || "The published procedure may no longer match the systems it describes."} Publishing a new revision clears this notice.
              </Notice>
            )}
            {editable && detail.restoredFromRevision !== null && (
              <Notice tone="neutral" className={styles.notice} title={`Restored from revision ${detail.restoredFromRevision}`}>
                This draft started from revision {detail.restoredFromRevision}. Earlier unpublished work, if any, is kept in the version history.
              </Notice>
            )}
            {!editable && (
              <Notice tone="neutral" className={styles.notice} title={detail.status === "published" ? "Published" : "In review"}>
                {detail.status === "published"
                  ? "This version is published and read-only. Use Edit as new draft to prepare the next version; the published revision stays in the history."
                  : "Editing is locked while the playbook is in review. Publish it, or return it to draft to make changes."}
              </Notice>
            )}
            <input
              className={styles.title}
              aria-label="Playbook title"
              placeholder="Playbook title"
              value={draft.input.title}
              readOnly={!editable}
              maxLength={200}
              onChange={(event) => setInput({ title: event.target.value })}
            />
            <textarea
              className={styles.summary}
              aria-label="Description"
              placeholder="One or two sentences on what this playbook achieves"
              value={draft.input.summary}
              readOnly={!editable}
              maxLength={2000}
              onChange={(event) => setInput({ summary: event.target.value })}
            />

            <TextSection
              title="Purpose"
              hint="Why and when to use this procedure."
              value={draft.content.purpose}
              editable={editable}
              onChange={(purpose) => setContent({ purpose })}
            />
            <TextSection
              title="Scope"
              hint="Systems, environments and versions it applies to, and what is out of scope."
              value={draft.content.scope}
              editable={editable}
              onChange={(scope) => setContent({ scope })}
            />
            {LIST_SECTIONS.map((section) => (
              <ListSection
                key={section.key}
                sectionKey={section.key}
                title={section.title}
                hint={section.hint}
                empty={section.empty}
                items={draft.content[section.key]}
                editable={editable}
                onChange={(change) => setList(section.key, change)}
              />
            ))}

            <section className={styles.section} aria-labelledby="playbook-steps">
              <h2 id="playbook-steps" className={styles.sectionTitle}>
                Steps
              </h2>
              {draft.content.steps.length === 0 ? (
                <p className={styles.muted}>No steps yet. Add the first step of the procedure.</p>
              ) : (
                <ol className={styles.steps}>
                  {draft.content.steps.map((step, index) => (
                    <StepCard
                      key={step.id}
                      step={step}
                      number={index + 1}
                      total={draft.content.steps.length}
                      assets={assets}
                      source={sourceText(step, detail.sessions)}
                      editable={editable}
                      onChange={(patch) => setSteps((steps) => steps.map((item) => (item.id === step.id ? editStep(item, patch) : item)))}
                      onMove={(delta) => setSteps((steps) => moveBy(steps, index, delta))}
                      onRemove={() => setSteps((steps) => steps.filter((item) => item.id !== step.id))}
                    />
                  ))}
                </ol>
              )}
              {editable && (
                <Button size="sm" icon={Plus} onClick={() => setSteps((steps) => [...steps, newStep()])}>
                  Add step
                </Button>
              )}
            </section>

            {CLOSING_SECTIONS.map((section) => (
              <ListSection
                key={section.key}
                sectionKey={section.key}
                title={section.title}
                hint={section.hint}
                empty={section.empty}
                items={draft.content[section.key]}
                editable={editable}
                onChange={(change) => setList(section.key, change)}
              />
            ))}
          </article>
        </div>

        <Inspector label="Playbook properties" className={styles.inspector}>
          <InspectorSection title="Properties">
            <div className={styles.fields}>
              <Select
                label="Project"
                options={projectOptions}
                value={draft.input.projectId ?? ""}
                disabled={!editable}
                onChange={(event) => setInput({ projectId: event.target.value || null })}
              />
              {(
                [
                  ["platform", "Platform", "e.g. AWS, FortiGate, Windows Server"],
                  ["product", "Product", "e.g. EC2, FortiOS, Active Directory"],
                  ["productVersion", "Version", "e.g. 7.4.3"],
                  ["environment", "Environment", "e.g. Production, Lab"],
                  ["taskType", "Task type", "e.g. Configuration, Troubleshooting"],
                  ["author", "Author", "Your name"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <TextField
                  key={key}
                  label={label}
                  value={draft.input[key]}
                  placeholder={placeholder}
                  readOnly={!editable}
                  maxLength={key === "author" ? 80 : 120}
                  onChange={(event) => setInput({ [key]: event.target.value })}
                />
              ))}
            </div>
          </InspectorSection>
          <InspectorSection title={`Sources (${detail.sessions.length})`}>
            {detail.sessions.length === 0 ? (
              <p className={styles.muted}>Written from scratch; no session is linked.</p>
            ) : (
              <ul className={styles.sources}>
                {detail.sessions.map((session) => (
                  <li key={session.id}>
                    <Link to={`/sessions/${session.id}`}>{session.title}</Link>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.muted}>
              Steps marked “From session” were copied from approved steps; “Edited” ones were changed afterwards. Everything else was
              written in this playbook.
            </p>
            {detail.basedOn && (
              <p className={styles.muted}>
                Duplicated from{" "}
                {detail.basedOn.playbookId && detail.basedOn.title ? (
                  <Link to={`/playbooks/${detail.basedOn.playbookId}`}>{detail.basedOn.title}</Link>
                ) : (
                  "a playbook that was later deleted"
                )}
                {detail.basedOn.revisionNumber !== null ? ` (revision ${detail.basedOn.revisionNumber})` : " (its working copy)"}.
              </p>
            )}
          </InspectorSection>
          <InspectorSection title={`Revisions (${detail.revisions.length})`}>
            {detail.revisions.length === 0 ? (
              <p className={styles.muted}>Not published yet. Publishing records an immutable revision.</p>
            ) : (
              <ol className={styles.revisions}>
                {detail.revisions.map((revision) => (
                  <li key={revision.id}>
                    <Link className={styles.revisionTitle} to={`/playbooks/${detail.id}/history?version=${revision.id}`}>
                      Revision {revision.revisionNumber}
                    </Link>
                    <span className={styles.muted}>
                      {formatDateTime(revision.createdAt)}
                      {revision.author ? ` \u00b7 ${revision.author}` : ""}
                    </span>
                    {revision.note && <span className={styles.revisionNote}>{revision.note}</span>}
                  </li>
                ))}
              </ol>
            )}
            {detail.restorePoints.length > 0 && (
              <p className={styles.muted}>{pluralize(detail.restorePoints.length, "saved draft")} from earlier restores.</p>
            )}
            <Button size="sm" icon={History} onClick={() => navigate(`/playbooks/${detail.id}/history`)}>
              Open version history
            </Button>
          </InspectorSection>
          <InspectorSection title="Details">
            <PropertyList
              items={[
                { label: "Steps", value: draft.content.steps.length },
                { label: "Images", value: detail.assets.length },
                { label: "Created", value: formatDateTime(detail.createdAt) },
                { label: "Updated", value: formatDateTime(detail.updatedAt) },
                { label: "Identifier", value: detail.id, mono: true },
              ]}
            />
          </InspectorSection>
        </Inspector>
      </div>

      <ConfirmDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        title="Publish this playbook?"
        confirmLabel="Publish"
        onConfirm={async () => {
          if (await changeStatus("published", publishNote)) setPublishNote("");
        }}
      >
        <p>
          Publishing records revision {detail.revisionCount + 1} as an immutable snapshot of {pluralize(draft.content.steps.length, "step")}. Later
          changes start a new draft.
        </p>
        <p>Check that verification steps describe real checks; DevTrace does not add verification results.</p>
        <TextArea label="Revision note" optional rows={2} maxLength={2000} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete \u201c${detail.title}\u201d?`}
        confirmLabel="Delete playbook"
        tone="danger"
        onConfirm={async () => {
          const result = await api.playbooks.remove(detail.id);
          toast.success("Playbook deleted", result.title);
          navigate("/playbooks", { replace: true });
        }}
      >
        <p>
          The playbook, its {pluralize(detail.revisions.length, "published revision")} and its {pluralize(detail.assets.length, "image copy", "image copies")} will be
          permanently deleted. Linked sessions and their evidence are not affected.
        </p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>
      <ExportDialog open={exporting} onClose={() => setExporting(false)} detail={detail} beforeExport={() => (editable ? autosave.saveNow() : Promise.resolve(true))} />
      <ConfirmDialog
        open={markingOutdated}
        onClose={() => setMarkingOutdated(false)}
        title="Mark this procedure as out of date?"
        confirmLabel="Mark as out of date"
        onConfirm={async () => {
          await api.playbooks.setOutdated(detail.id, true, outdatedNote);
          setOutdatedNote("");
          toast.success("Marked as out of date", "The playbook, the library and exports now say so.");
          reload();
        }}
      >
        <p>Readers see a notice in the editor, the playbook lists, the Knowledge Library and every export of the current version. Publishing a new revision clears it.</p>
        <TextArea
          label="What changed"
          optional
          rows={2}
          maxLength={2000}
          placeholder="e.g. Firmware 7.6 moved this setting"
          value={outdatedNote}
          onChange={(event) => setOutdatedNote(event.target.value)}
        />
      </ConfirmDialog>
    </Page>
  );
}

function TextSection({
  title,
  hint,
  value,
  editable,
  onChange,
}: {
  title: string;
  hint: string;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const id = `playbook-${title.toLowerCase()}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      <p className={styles.hint}>{hint}</p>
      <textarea
        className={styles.prose}
        aria-label={title}
        value={value}
        readOnly={!editable}
        maxLength={10000}
        placeholder={editable ? `Add ${title.toLowerCase()}` : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </section>
  );
}

function ListSection({
  sectionKey,
  title,
  hint,
  empty,
  items,
  editable,
  onChange,
}: {
  sectionKey: ListSectionKey;
  title: string;
  hint: string;
  empty: string;
  items: ListItem[];
  editable: boolean;
  onChange: (change: (items: ListItem[]) => ListItem[]) => void;
}) {
  const id = `playbook-${sectionKey}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      <p className={styles.hint}>{hint}</p>
      {items.length === 0 ? (
        <p className={styles.muted}>{empty}</p>
      ) : (
        <ul className={styles.items}>
          {items.map((item, index) => (
            <li key={item.id} className={styles.item}>
              <textarea
                className={styles.itemText}
                aria-label={`${title} item ${index + 1}`}
                value={item.text}
                readOnly={!editable}
                maxLength={2000}
                onChange={(event) => onChange((current) => current.map((entry) => (entry.id === item.id ? editItem(entry, event.target.value) : entry)))}
              />
              <OriginTag origin={item.origin} />
              {editable && (
                <IconButton
                  size="sm"
                  icon={X}
                  label={`Remove ${title.toLowerCase()} item ${index + 1}`}
                  onClick={() => onChange((current) => current.filter((entry) => entry.id !== item.id))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange((current) => [...current, newItem()])}>
          Add item
        </Button>
      )}
    </section>
  );
}

interface StepCardProps {
  step: PlaybookStep;
  number: number;
  total: number;
  assets: Map<string, PlaybookAsset>;
  source: string | null;
  editable: boolean;
  onChange: (patch: Partial<PlaybookStep>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function StepCard({ step, number, total, assets, source, editable, onChange, onMove, onRemove }: StepCardProps) {
  const label = `Step ${number}`;
  return (
    <li className={styles.step} aria-label={label}>
      <div className={styles.stepHeader}>
        <span className={styles.stepNumber} aria-hidden="true">
          {number}
        </span>
        <input
          className={styles.stepTitle}
          aria-label={`${label} title`}
          placeholder="What to do"
          value={step.title}
          readOnly={!editable}
          maxLength={200}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        <OriginTag origin={step.origin} />
        {editable && (
          <span className={styles.stepActions}>
            <IconButton size="sm" icon={ArrowUp} label={`Move ${label.toLowerCase()} up`} disabledReason={number === 1 ? "This is the first step." : undefined} onClick={() => onMove(-1)} />
            <IconButton
              size="sm"
              icon={ArrowDown}
              label={`Move ${label.toLowerCase()} down`}
              disabledReason={number === total ? "This is the last step." : undefined}
              onClick={() => onMove(1)}
            />
            <IconButton size="sm" icon={Trash2} label={`Remove ${label.toLowerCase()}`} onClick={onRemove} />
          </span>
        )}
      </div>
      {source && (
        <p className={styles.source}>
          {source}
          {step.sourceSessionId && step.sourceEventId && (
            <>
              {" \u00b7 "}
              <Link to={`/sessions/${step.sourceSessionId}?step=${step.sourceEventId}`}>Open evidence</Link>
            </>
          )}
        </p>
      )}
      <StepField label={`${label} instruction`} title="Instruction" value={step.instruction} editable={editable} onChange={(instruction) => onChange({ instruction })} />
      <StepField
        label={`${label} command`}
        title="Command or configuration"
        value={step.command}
        editable={editable}
        mono
        onChange={(command) => onChange({ command })}
      />
      <StepField
        label={`${label} expected result`}
        title="Expected result"
        value={step.expectedResult}
        editable={editable}
        onChange={(expectedResult) => onChange({ expectedResult })}
      />
      <StepField label={`${label} note`} title="Note" value={step.note} editable={editable} onChange={(note) => onChange({ note })} />
      {step.assetIds.length > 0 && (
        <ul className={styles.images} aria-label={`${label} screenshots`}>
          {step.assetIds.map((assetId) => (
            <li key={assetId} className={styles.image}>
              <PlaybookImage asset={assets.get(assetId)} alt={`Screenshot for ${label.toLowerCase()}`}>
                {editable && (
                  <IconButton
                    size="sm"
                    icon={X}
                    label={`Remove screenshot from ${label.toLowerCase()}`}
                    onClick={() => onChange({ assetIds: step.assetIds.filter((id) => id !== assetId) })}
                  />
                )}
              </PlaybookImage>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StepField({
  label,
  title,
  value,
  editable,
  mono = false,
  onChange,
}: {
  label: string;
  title: string;
  value: string;
  editable: boolean;
  mono?: boolean;
  onChange: (value: string) => void;
}) {
  if (!editable && !value) return null;
  return (
    <div className={styles.stepField}>
      <span className={styles.fieldLabel}>{title}</span>
      <textarea
        className={cx(styles.stepText, mono && styles.mono)}
        aria-label={label}
        value={value}
        readOnly={!editable}
        spellCheck={!mono}
        maxLength={mono ? 20000 : 10000}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
