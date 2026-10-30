import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BadgeCheck, Check, FileDiff, FilePlus2, Pencil, RotateCcw, SearchX, Trash2, X } from "lucide-react";

import {
  Button,
  ConfirmDialog,
  DataTable,
  DiffView,
  EmptyState,
  Inspector,
  InspectorSection,
  Notice,
  PropertyList,
  SearchField,
  Select,
  StatusBadge,
  TextArea,
  useToast,
  type Column,
  type SelectOption,
  type SortState,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, toApiError, type ApprovalState, type ChangeAssertion, type ChangeRecord } from "../../lib/api";
import { formatDateTime, pluralize } from "../../lib/format";
import { useHotkeys, useResource } from "../../lib/hooks";
import { approvalState, changeAssertion } from "../../lib/status";
import list from "../shared/ListPage.module.css";
import { ChangeFormDialog } from "./ChangeFormDialog";

const ALL = "all";

const SOURCE_LABELS: Record<ChangeRecord["source"], string> = {
  manual: "Recorded by a person",
  file_watch: "Watched configuration file",
};

const assertionOptions: SelectOption[] = [
  { value: ALL, label: "Any evidence level" },
  ...Object.entries(changeAssertion).map(([value, item]) => ({ value, label: item.label })),
];

const approvalOptions: SelectOption[] = [
  { value: ALL, label: "Any approval state" },
  ...Object.entries(approvalState).map(([value, item]) => ({ value, label: item.label })),
];

const columns: Column<ChangeRecord>[] = [
  {
    id: "occurred",
    header: "When",
    width: "170px",
    tone: "secondary",
    sortValue: (change) => change.occurredAt,
    cell: (change) => formatDateTime(change.occurredAt),
  },
  {
    id: "target",
    header: "Target",
    width: "30%",
    sortValue: (change) => change.target,
    cell: (change) => (
      <span className={list.primaryCell}>
        <span className={`${list.primaryText} mono`}>{change.target}</span>
        {change.summary && <span className={list.secondaryText}>{change.summary}</span>}
      </span>
    ),
  },
  {
    id: "project",
    header: "Project",
    tone: "secondary",
    sortValue: (change) => change.projectName ?? "",
    cell: (change) => change.projectName ?? <span className={list.muted}>Unassigned</span>,
  },
  {
    id: "environment",
    header: "Environment",
    tone: "secondary",
    sortValue: (change) => change.environment,
    cell: (change) => change.environment || <span className={list.muted}>—</span>,
  },
  {
    id: "assertion",
    header: "Evidence",
    width: "120px",
    sortValue: (change) => change.assertion,
    cell: (change) => <StatusBadge status={changeAssertion[change.assertion]} plain />,
  },
  {
    id: "approval",
    header: "Approval",
    width: "120px",
    sortValue: (change) => change.approvalState,
    cell: (change) => <StatusBadge status={approvalState[change.approvalState]} plain />,
  },
];

const ASSERTION_ORDER: ChangeAssertion[] = ["observed", "declared", "verified"];

type Editing = { kind: "new" } | { kind: "edit"; change: ChangeRecord } | null;

export function ChangeHistoryPage() {
  const changes = useResource(api.changes.list);
  const [params, setParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [assertion, setAssertion] = useState(ALL);
  const [approval, setApproval] = useState(ALL);
  const [sort, setSort] = useState<SortState>({ columnId: "occurred", direction: "desc" });
  const [editing, setEditing] = useState<Editing>(null);

  useHotkeys(useMemo(() => [{ key: "f", mod: true, handler: () => searchRef.current?.focus() }], []));

  const all = changes.data ?? [];
  const selectedId = params.get("selected");
  const selected = all.find((change) => change.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (changes.data ?? []).filter((change) => {
      if (assertion !== ALL && change.assertion !== assertion) return false;
      if (approval !== ALL && change.approvalState !== approval) return false;
      if (!needle) return true;
      return [change.target, change.summary, change.projectName ?? "", change.sessionTitle ?? "", change.environment].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [changes.data, query, assertion, approval]);

  const filtersActive = query.trim() !== "" || assertion !== ALL || approval !== ALL;
  const clearFilters = () => {
    setQuery("");
    setAssertion(ALL);
    setApproval(ALL);
  };

  const select = (change: ChangeRecord | null) => {
    setParams(change ? { selected: change.id } : {}, { replace: true });
  };

  const empty =
    all.length === 0 ? (
      <EmptyState
        icon={FileDiff}
        title="No changes recorded"
        description="Record a change you made, or watch a configuration file from a session's Integrations. Every record states its evidence level, and a captured event is never treated as a verified change on its own:"
        actions={
          <div className={list.legend}>
            {ASSERTION_ORDER.map((key) => (
              <div key={key} className={list.legendRow}>
                <StatusBadge status={changeAssertion[key]} showDescription={false} />
                <span>{changeAssertion[key].description}</span>
              </div>
            ))}
          </div>
        }
      />
    ) : (
      <EmptyState
        icon={SearchX}
        title="No changes match these filters"
        description="Try a different search term or clear the filters."
        actions={<Button onClick={clearFilters}>Clear filters</Button>}
      />
    );

  return (
    <Page
      title="Change History"
      actions={
        <Button variant="primary" icon={FilePlus2} onClick={() => setEditing({ kind: "new" })}>
          Record Change
        </Button>
      }
      inspector={
        selected ? (
          <ChangeInspector
            key={selected.id}
            change={selected}
            onClose={() => select(null)}
            onChanged={changes.reload}
            onEdit={() => setEditing({ kind: "edit", change: selected })}
            onDeleted={() => {
              select(null);
              changes.reload();
            }}
          />
        ) : undefined
      }
    >
      <div className={list.container}>
        {changes.error && (
          <Notice
            tone="danger"
            role="alert"
            title="Change history could not be loaded"
            action={
              <Button size="sm" onClick={changes.reload}>
                Retry
              </Button>
            }
          >
            {changes.error.message}
          </Notice>
        )}
        <div className={list.filters} role="search">
          <SearchField
            ref={searchRef}
            label="Search changes"
            placeholder="Search target, project or session"
            value={query}
            onValueChange={setQuery}
            className={list.search}
          />
          <Select aria-label="Filter by evidence level" options={assertionOptions} value={assertion} onChange={(event) => setAssertion(event.target.value)} />
          <Select aria-label="Filter by approval state" options={approvalOptions} value={approval} onChange={(event) => setApproval(event.target.value)} />
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          )}
          <span className={list.count} aria-live="polite">
            {pluralize(filtered.length, "change")}
          </span>
        </div>
        <div className={list.table}>
          <DataTable
            label="Change history"
            columns={columns}
            rows={filtered}
            getRowId={(change) => change.id}
            loading={changes.loading && !changes.data}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={select}
            selectedId={selectedId}
            empty={empty}
          />
        </div>
      </div>
      {editing && (
        <ChangeFormDialog
          change={editing.kind === "edit" ? editing.change : undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            changes.reload();
            select(saved);
          }}
        />
      )}
    </Page>
  );
}

interface ChangeInspectorProps {
  change: ChangeRecord;
  onClose: () => void;
  onChanged: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}

function ChangeInspector({ change, onClose, onChanged, onEdit, onDeleted }: ChangeInspectorProps) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<ApprovalState | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [note, setNote] = useState("");
  const [deleting, setDeleting] = useState(false);

  const review = async (state: ApprovalState) => {
    setBusy(state);
    try {
      await api.changes.review(change.id, state, comment);
      setComment("");
      toast.success(state === "approved" ? "Change approved" : state === "rejected" ? "Change rejected" : "Review reset");
      onChanged();
    } catch (raw) {
      toast.error("The review could not be saved", toApiError(raw).message);
    } finally {
      setBusy(null);
    }
  };

  const editable = change.assertion === "declared" && change.approvalState === "pending";
  const verifyBlocked =
    change.assertion === "verified" ? "This change is already verified." : change.approvalState === "rejected" ? "A rejected change cannot be verified." : undefined;

  return (
    <Inspector label="Change details" eyebrow="Change" title={change.target} onClose={onClose}>
      <InspectorSection title="Evidence">
        <PropertyList
          items={[
            { label: "Evidence level", value: <StatusBadge status={changeAssertion[change.assertion]} /> },
            { label: "Approval", value: <StatusBadge status={approvalState[change.approvalState]} /> },
            { label: "Source", value: SOURCE_LABELS[change.source] },
            {
              label: "Session",
              value: change.sessionId ? <Link to={`/sessions/${change.sessionId}`}>{change.sessionTitle ?? "Open session"}</Link> : null,
            },
            {
              label: "Step",
              value:
                change.sessionId && change.eventId ? (
                  <Link to={`/sessions/${change.sessionId}?step=${change.eventId}`}>{change.eventTitle ?? "Open step"}</Link>
                ) : null,
            },
          ]}
        />
        {change.assertion === "observed" && (
          <p className={list.muted}>Observed values are what DevTrace recorded from the watched file. They cannot be edited.</p>
        )}
      </InspectorSection>
      <InspectorSection title="Values">
        <DiffView label={change.target} before={change.beforeValue} after={change.afterValue} />
      </InspectorSection>
      <InspectorSection title="Review">
        {change.reviewedAt && (
          <PropertyList
            items={[
              { label: "Reviewed", value: `${formatDateTime(change.reviewedAt)}${change.reviewer ? ` by ${change.reviewer}` : ""}` },
              { label: "Comment", value: change.reviewComment || null },
            ]}
          />
        )}
        <TextArea label="Comment" optional rows={2} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} />
        <div className={list.filters}>
          <Button size="sm" icon={Check} loading={busy === "approved"} disabledReason={change.approvalState === "approved" ? "Already approved." : undefined} onClick={() => void review("approved")}>
            Approve
          </Button>
          <Button
            size="sm"
            icon={X}
            loading={busy === "rejected"}
            disabledReason={change.approvalState === "rejected" ? "Already rejected." : change.assertion === "verified" ? "A verified change cannot be rejected." : undefined}
            onClick={() => void review("rejected")}
          >
            Reject
          </Button>
          {change.approvalState !== "pending" && (
            <Button size="sm" variant="ghost" icon={RotateCcw} loading={busy === "pending"} onClick={() => void review("pending")}>
              Reset review
            </Button>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title="Verification">
        {change.verifiedAt ? (
          <PropertyList
            items={[
              { label: "Verified", value: `${formatDateTime(change.verifiedAt)}${change.verifiedBy ? ` by ${change.verifiedBy}` : ""}` },
              { label: "How", value: change.verificationNote },
            ]}
          />
        ) : (
          <p className={list.muted}>Not verified. DevTrace never verifies a change on its own; record how you checked the outcome.</p>
        )}
        <Button size="sm" icon={BadgeCheck} disabledReason={verifyBlocked} onClick={() => setVerifying(true)}>
          Mark verified…
        </Button>
      </InspectorSection>
      <InspectorSection title="Context">
        <PropertyList
          items={[
            { label: "Occurred", value: formatDateTime(change.occurredAt) },
            { label: "Project", value: change.projectName },
            { label: "Environment", value: change.environment },
            { label: "Platform", value: change.platform },
            { label: "Version", value: change.version, mono: true },
          ]}
        />
        <div className={list.filters}>
          <Button size="sm" icon={Pencil} disabledReason={editable ? undefined : "Only declared changes that are not reviewed yet can be edited."} onClick={onEdit}>
            Edit…
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDeleting(true)}>
            Delete…
          </Button>
        </div>
      </InspectorSection>

      <ConfirmDialog
        open={verifying}
        onClose={() => setVerifying(false)}
        title="Mark this change as verified?"
        confirmLabel="Mark verified"
        onConfirm={async () => {
          await api.changes.verify(change.id, note);
          setNote("");
          toast.success("Change verified", "The verification note is stored with the change.");
          onChanged();
        }}
      >
        <p>Describe how you confirmed the outcome, for example the command you ran and what it returned. This note is required.</p>
        <TextArea label="How the outcome was verified" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this change record?"
        confirmLabel="Delete change"
        tone="danger"
        onConfirm={async () => {
          await api.changes.remove(change.id);
          toast.success("Change deleted", change.target);
          onDeleted();
        }}
      >
        <p>The record, its values, review and verification are permanently deleted. Linked sessions and steps are not affected.</p>
      </ConfirmDialog>
    </Inspector>
  );
}
