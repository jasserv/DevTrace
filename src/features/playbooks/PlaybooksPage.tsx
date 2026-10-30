import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Check, NotebookText, Plus, SearchX } from "lucide-react";

import {
  Button,
  DataTable,
  EmptyState,
  Icon,
  Notice,
  SearchField,
  StatusBadge,
  Tabs,
  tabId,
  tabPanelId,
  type Column,
  type SortState,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, type PlaybookStatus, type PlaybookSummary } from "../../lib/api";
import { formatDateTime, pluralize } from "../../lib/format";
import { useHotkeys, useResource } from "../../lib/hooks";
import { outdatedStatus, playbookStatus } from "../../lib/status";
import list from "../shared/ListPage.module.css";
import { NewPlaybookDialog } from "./NewPlaybookDialog";

type Tab = "all" | PlaybookStatus;

/** Structure every generated playbook will follow (from the product specification). */
const PLAYBOOK_SECTIONS = [
  "Purpose, scope and environment",
  "Prerequisites and required permissions",
  "Numbered steps linked to evidence",
  "Commands and configuration snippets",
  "Expected results and verification",
  "Warnings, troubleshooting and rollback",
];

const columns: Column<PlaybookSummary>[] = [
  {
    id: "title",
    header: "Playbook",
    width: "34%",
    sortValue: (playbook) => playbook.title,
    cell: (playbook) => (
      <span className={list.primaryCell}>
        <span className={list.primaryText}>{playbook.title}</span>
        {playbook.summary && <span className={list.secondaryText}>{playbook.summary}</span>}
      </span>
    ),
  },
  {
    id: "project",
    header: "Project",
    tone: "secondary",
    sortValue: (playbook) => playbook.projectName ?? "",
    cell: (playbook) => playbook.projectName ?? <span className={list.muted}>Unassigned</span>,
  },
  {
    id: "platform",
    header: "Platform",
    tone: "secondary",
    sortValue: (playbook) => playbook.platform,
    cell: (playbook) => playbook.platform || <span className={list.muted}>—</span>,
  },
  {
    id: "version",
    header: "Version",
    width: "100px",
    tone: "mono",
    sortValue: (playbook) => playbook.productVersion,
    cell: (playbook) => playbook.productVersion || <span className={list.muted}>—</span>,
  },
  {
    id: "updated",
    header: "Updated",
    width: "170px",
    tone: "secondary",
    sortValue: (playbook) => playbook.updatedAt,
    cell: (playbook) => formatDateTime(playbook.updatedAt),
  },
  {
    id: "status",
    header: "Status",
    width: "150px",
    sortValue: (playbook) => playbook.status,
    cell: (playbook) => (
      <span className={list.statusCell}>
        <StatusBadge status={playbookStatus[playbook.status]} plain />
        {playbook.outdatedAt && <StatusBadge status={outdatedStatus} plain />}
      </span>
    ),
  },
];

export function PlaybooksPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  // "?new=1" (from the Overview) opens the create dialog.
  const createOpen = creating || params.get("new") === "1";
  const closeCreate = () => {
    setCreating(false);
    if (params.has("new")) setParams({}, { replace: true });
  };
  const playbooks = useResource(api.playbooks.list);
  const searchRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ columnId: "updated", direction: "desc" });

  useHotkeys(useMemo(() => [{ key: "f", mod: true, handler: () => searchRef.current?.focus() }], []));

  const all = playbooks.data ?? [];
  const countFor = (status: PlaybookStatus) => all.filter((playbook) => playbook.status === status).length;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (playbooks.data ?? []).filter((playbook) => {
      if (tab !== "all" && playbook.status !== tab) return false;
      if (!needle) return true;
      return [playbook.title, playbook.summary, playbook.platform, playbook.product, playbook.projectName ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [playbooks.data, tab, query]);

  const empty =
    all.length === 0 ? (
      <EmptyState
        icon={NotebookText}
        title="No playbooks yet"
        description="Playbooks turn reviewed capture evidence into structured, editable and versioned procedures. Generated content stays editable, links back to its evidence, and never claims a verification that was not recorded. Create one from a reviewed session, or start from a blank draft."
        actions={
          <ul className={list.facts} aria-label="Playbook structure">
            {PLAYBOOK_SECTIONS.map((section) => (
              <li key={section} className={list.fact}>
                <Icon icon={Check} size={13} />
                {section}
              </li>
            ))}
          </ul>
        }
      />
    ) : (
      <EmptyState
        icon={SearchX}
        title="No playbooks match"
        description="Try a different search term or status."
        actions={
          <Button
            onClick={() => {
              setQuery("");
              setTab("all");
            }}
          >
            Clear filters
          </Button>
        }
      />
    );

  return (
    <Page
      title="Playbooks"
      actions={
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
          New Playbook
        </Button>
      }
    >
      <div className={list.container}>
        {playbooks.error && (
          <Notice
            tone="danger"
            role="alert"
            title="Playbooks could not be loaded"
            action={
              <Button size="sm" onClick={playbooks.reload}>
                Retry
              </Button>
            }
          >
            {playbooks.error.message}
          </Notice>
        )}
        <div className={list.tabs}>
          <Tabs<Tab>
            label="Playbook status"
            idPrefix="playbooks"
            value={tab}
            onChange={setTab}
            options={[
              { value: "all", label: "All", count: all.length },
              { value: "draft", label: "Drafts", count: countFor("draft") },
              { value: "in_review", label: "In review", count: countFor("in_review") },
              { value: "published", label: "Published", count: countFor("published") },
            ]}
          />
        </div>
        <div role="tabpanel" id={tabPanelId("playbooks", tab)} aria-labelledby={tabId("playbooks", tab)}>
          <div className={list.filters} role="search" style={{ marginBottom: "var(--space-3)" }}>
            <SearchField
              ref={searchRef}
              label="Search playbooks"
              placeholder="Search title, platform, product or project"
              value={query}
              onValueChange={setQuery}
              className={list.search}
            />
            <span className={list.count} aria-live="polite">
              {pluralize(filtered.length, "playbook")}
            </span>
          </div>
          <div className={list.table}>
            <DataTable
              label="Playbooks"
              columns={columns}
              rows={filtered}
              getRowId={(playbook) => playbook.id}
              loading={playbooks.loading && !playbooks.data}
              sort={sort}
              onSortChange={setSort}
              empty={empty}
              onRowActivate={(playbook) => navigate(`/playbooks/${playbook.id}`)}
            />
          </div>
        </div>
      </div>
      {createOpen && <NewPlaybookDialog open onClose={closeCreate} />}
    </Page>
  );
}
