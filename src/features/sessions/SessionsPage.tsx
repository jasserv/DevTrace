import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ListVideo, Plus, SearchX } from "lucide-react";

import {
  Button,
  DataTable,
  EmptyState,
  Notice,
  SearchField,
  Select,
  StatusBadge,
  useToast,
  type Column,
  type SelectOption,
  type SortState,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, type SessionDetail, type SessionSummary } from "../../lib/api";
import { formatDateTime, formatRelative, pluralize } from "../../lib/format";
import { useHotkeys, useResource } from "../../lib/hooks";
import { formatShortcut } from "../../lib/platform";
import { reviewState, sessionStatus } from "../../lib/status";
import list from "../shared/ListPage.module.css";
import { SessionFormDialog } from "./SessionFormDialog";

const ALL = "all";
const UNASSIGNED = "unassigned";

const statusOptions: SelectOption[] = [
  { value: ALL, label: "All statuses" },
  ...Object.entries(sessionStatus).map(([value, status]) => ({ value, label: status.label })),
];

const reviewOptions: SelectOption[] = [
  { value: ALL, label: "Any review state" },
  ...Object.entries(reviewState).map(([value, state]) => ({ value, label: state.label })),
];

const columns: Column<SessionSummary>[] = [
  {
    id: "title",
    header: "Session",
    width: "28%",
    sortValue: (session) => session.title,
    cell: (session) => (
      <span className={list.primaryCell}>
        <span className={list.primaryText}>{session.title}</span>
        {session.environment && <span className={list.secondaryText}>{session.environment}</span>}
      </span>
    ),
  },
  {
    id: "project",
    header: "Project",
    tone: "secondary",
    sortValue: (session) => session.projectName ?? "",
    cell: (session) => session.projectName ?? <span className={list.muted}>Unassigned</span>,
  },
  {
    id: "application",
    header: "Application",
    tone: "secondary",
    sortValue: (session) => session.application,
    cell: (session) => session.application || <span className={list.muted}>—</span>,
  },
  {
    id: "steps",
    header: "Steps",
    width: "68px",
    align: "end",
    tone: "secondary",
    sortValue: (session) => session.eventCount,
    cell: (session) => session.eventCount,
  },
  {
    id: "updated",
    header: "Updated",
    width: "124px",
    tone: "secondary",
    sortValue: (session) => session.updatedAt,
    cell: (session) => (
      <time dateTime={session.updatedAt} title={formatDateTime(session.updatedAt)}>
        {formatRelative(session.updatedAt)}
      </time>
    ),
  },
  {
    id: "status",
    header: "Status",
    width: "120px",
    sortValue: (session) => session.status,
    cell: (session) => <StatusBadge status={sessionStatus[session.status]} plain />,
  },
  {
    id: "review",
    header: "Review",
    width: "130px",
    sortValue: (session) => session.reviewState,
    cell: (session) => <StatusBadge status={reviewState[session.reviewState]} plain />,
  },
  {
    id: "playbooks",
    header: "Playbooks",
    width: "92px",
    align: "end",
    tone: "secondary",
    sortValue: (session) => session.playbookCount,
    cell: (session) => session.playbookCount,
  },
];

export function SessionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const sessions = useResource(api.sessions.list);
  const projects = useResource(api.projects.list);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(ALL);
  const [review, setReview] = useState(ALL);
  const [sort, setSort] = useState<SortState>({ columnId: "updated", direction: "desc" });
  const [creating, setCreating] = useState(false);

  // The project filter lives in the URL (?project=<id>) so other pages can link to it.
  // "?new=1" (from the Overview, Capture or a project) opens the create dialog once.
  const project = params.get("project") ?? ALL;
  const wantsNew = params.get("new") === "1";
  const createOpen = creating || wantsNew;
  const filterProjectId = project !== ALL && project !== UNASSIGNED ? project : null;

  const updateParams = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next, { replace: true });
  };
  const setProject = (value: string) =>
    updateParams((next) => {
      if (value === ALL) next.delete("project");
      else next.set("project", value);
    });

  useHotkeys(
    useMemo(
      () => [
        { key: "f", mod: true, handler: () => searchRef.current?.focus() },
        { key: "n", mod: true, handler: () => setCreating(true) },
      ],
      [],
    ),
  );

  const projectOptions: SelectOption[] = useMemo(() => {
    const options = [
      { value: ALL, label: "All projects" },
      { value: UNASSIGNED, label: "Unassigned" },
      ...(projects.data ?? []).map((item) => ({ value: item.id, label: item.name })),
    ];
    // A linked project that no longer exists still needs an option to display.
    if (filterProjectId && projects.data && !projects.data.some((item) => item.id === filterProjectId)) {
      options.push({ value: filterProjectId, label: "Unknown project" });
    }
    return options;
  }, [projects.data, filterProjectId]);

  const all = sessions.data ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sessions.data ?? []).filter((session) => {
      if (status !== ALL && session.status !== status) return false;
      if (review !== ALL && session.reviewState !== review) return false;
      if (project === UNASSIGNED && session.projectId !== null) return false;
      if (project !== ALL && project !== UNASSIGNED && session.projectId !== project) return false;
      if (!needle) return true;
      return [session.title, session.application, session.environment, session.projectName ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [sessions.data, query, status, review, project]);

  const filtersActive = query.trim() !== "" || status !== ALL || review !== ALL || project !== ALL;
  const clearFilters = () => {
    setQuery("");
    setStatus(ALL);
    setReview(ALL);
    setProject(ALL);
  };

  const closeCreate = () => {
    setCreating(false);
    if (wantsNew) updateParams((next) => next.delete("new"));
  };

  const onCreated = (session: SessionDetail) => {
    setCreating(false);
    toast.success("Session created", session.title);
    navigate(`/sessions/${session.id}`, { replace: wantsNew });
  };

  const empty =
    all.length === 0 ? (
      <EmptyState
        icon={ListVideo}
        title="No sessions yet"
        description="A session documents one technical task: the steps, notes, commands and screenshots needed to review it and turn it into a repeatable playbook. Capture screenshots from the Capture workspace, or add steps and images yourself."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New session
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={SearchX}
        title="No sessions match these filters"
        description="Try a different search term or clear the filters."
        actions={<Button onClick={clearFilters}>Clear filters</Button>}
      />
    );

  return (
    <Page
      title="Sessions"
      actions={
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} shortcut={formatShortcut("N")} tooltip="Create a session">
          New Session
        </Button>
      }
    >
      <div className={list.container}>
        {sessions.error && (
          <Notice
            tone="danger"
            role="alert"
            title="Sessions could not be loaded"
            action={
              <Button size="sm" onClick={sessions.reload}>
                Retry
              </Button>
            }
          >
            {sessions.error.message}
          </Notice>
        )}
        <div className={list.filters} role="search">
          <SearchField
            ref={searchRef}
            label="Search sessions"
            placeholder="Search title, application or project"
            value={query}
            onValueChange={setQuery}
            className={list.search}
          />
          <Select aria-label="Filter by status" options={statusOptions} value={status} onChange={(event) => setStatus(event.target.value)} />
          <Select aria-label="Filter by review state" options={reviewOptions} value={review} onChange={(event) => setReview(event.target.value)} />
          <Select aria-label="Filter by project" options={projectOptions} value={project} onChange={(event) => setProject(event.target.value)} />
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          )}
          <span className={list.count} aria-live="polite">
            {filtersActive ? `${filtered.length} of ${pluralize(all.length, "session")}` : pluralize(all.length, "session")}
          </span>
        </div>
        <div className={list.table}>
          <DataTable
            label="Capture sessions"
            columns={columns}
            rows={filtered}
            getRowId={(session) => session.id}
            loading={sessions.loading && !sessions.data}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(session) => navigate(`/sessions/${session.id}`)}
            empty={empty}
          />
        </div>
      </div>

      {createOpen && <SessionFormDialog defaultProjectId={filterProjectId} onClose={closeCreate} onSaved={onCreated} />}
    </Page>
  );
}
