import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Library, SearchX } from "lucide-react";

import {
  Button,
  DataTable,
  EmptyState,
  Notice,
  SearchField,
  Select,
  StatusBadge,
  type Column,
  type SelectOption,
  type SortState,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, type PlaybookSummary } from "../../lib/api";
import { formatDate, pluralize } from "../../lib/format";
import { useHotkeys, useResource } from "../../lib/hooks";
import { outdatedStatus, playbookStatus } from "../../lib/status";
import list from "../shared/ListPage.module.css";

const ALL = "all";

type FacetKey = "platform" | "product" | "productVersion" | "environment" | "taskType" | "projectName";

const FACETS: Array<{ key: FacetKey; label: string; all: string }> = [
  { key: "platform", label: "Platform", all: "All platforms" },
  { key: "product", label: "Product", all: "All products" },
  { key: "productVersion", label: "Version", all: "All versions" },
  { key: "environment", label: "Environment", all: "All environments" },
  { key: "taskType", label: "Task type", all: "All task types" },
  { key: "projectName", label: "Project", all: "All projects" },
];

/** Playbooks with at least one published revision, whatever the state of their working copy. */
const RELEASED = "released";

const statusOptions: SelectOption[] = [
  { value: RELEASED, label: "Published versions" },
  { value: ALL, label: "Any status" },
  ...Object.entries(playbookStatus).map(([value, item]) => ({ value, label: `Working copy: ${item.label.toLowerCase()}` })),
];

type Freshness = "any" | "current" | "outdated";

const freshnessOptions: SelectOption[] = [
  { value: "any", label: "Current and out of date" },
  { value: "current", label: "Current only" },
  { value: "outdated", label: "Out of date only" },
];

const columns: Column<PlaybookSummary>[] = [
  {
    id: "title",
    header: "Playbook",
    width: "30%",
    sortValue: (playbook) => playbook.title,
    cell: (playbook) => (
      <span className={list.primaryCell}>
        <span className={list.primaryText}>{playbook.title}</span>
        {playbook.taskType && <span className={list.secondaryText}>{playbook.taskType}</span>}
      </span>
    ),
  },
  { id: "platform", header: "Platform", tone: "secondary", sortValue: (p) => p.platform, cell: (p) => p.platform || "—" },
  { id: "product", header: "Product", tone: "secondary", sortValue: (p) => p.product, cell: (p) => p.product || "—" },
  { id: "version", header: "Version", width: "96px", tone: "mono", sortValue: (p) => p.productVersion, cell: (p) => p.productVersion || "—" },
  { id: "environment", header: "Environment", tone: "secondary", sortValue: (p) => p.environment, cell: (p) => p.environment || "—" },
  { id: "revision", header: "Revision", width: "88px", tone: "secondary", sortValue: (p) => p.revisionCount, cell: (p) => (p.revisionCount > 0 ? `${p.revisionCount}` : "—") },
  { id: "updated", header: "Updated", width: "120px", tone: "secondary", sortValue: (p) => p.updatedAt, cell: (p) => formatDate(p.updatedAt) },
  {
    id: "status",
    header: "Status",
    width: "150px",
    sortValue: (p) => p.status,
    cell: (p) => (
      <span className={list.statusCell}>
        <StatusBadge status={playbookStatus[p.status]} plain />
        {p.outdatedAt && <StatusBadge status={outdatedStatus} plain />}
      </span>
    ),
  },
];

const emptyFacets = (): Record<FacetKey, string> => ({
  platform: ALL,
  product: ALL,
  productVersion: ALL,
  environment: ALL,
  taskType: ALL,
  projectName: ALL,
});

/** Searchable library of reusable playbooks with metadata facets derived from real data. */
export function LibraryPage() {
  const navigate = useNavigate();
  const playbooks = useResource(api.playbooks.list);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(RELEASED);
  const [freshness, setFreshness] = useState<Freshness>("any");
  const [facets, setFacets] = useState(emptyFacets);
  const [sort, setSort] = useState<SortState>({ columnId: "title", direction: "asc" });

  useHotkeys(useMemo(() => [{ key: "f", mod: true, handler: () => searchRef.current?.focus() }], []));

  const all = useMemo(() => playbooks.data ?? [], [playbooks.data]);

  const facetOptions = useMemo(() => {
    const options = {} as Record<FacetKey, SelectOption[]>;
    for (const facet of FACETS) {
      const values = Array.from(new Set(all.map((playbook) => playbook[facet.key] ?? "").filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      );
      options[facet.key] = [{ value: ALL, label: facet.all }, ...values.map((value) => ({ value, label: value }))];
    }
    return options;
  }, [all]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((playbook) => {
      if (status === RELEASED ? playbook.revisionCount === 0 : status !== ALL && playbook.status !== status) return false;
      if (freshness === "current" && playbook.outdatedAt) return false;
      if (freshness === "outdated" && !playbook.outdatedAt) return false;
      for (const facet of FACETS) {
        const wanted = facets[facet.key];
        if (wanted !== ALL && (playbook[facet.key] ?? "") !== wanted) return false;
      }
      if (!needle) return true;
      return [playbook.title, playbook.summary, playbook.platform, playbook.product, playbook.taskType].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [all, query, status, freshness, facets]);

  const filtersActive = query.trim() !== "" || status !== RELEASED || freshness !== "any" || FACETS.some((facet) => facets[facet.key] !== ALL);
  const clearFilters = () => {
    setQuery("");
    setStatus(RELEASED);
    setFreshness("any");
    setFacets(emptyFacets());
  };

  const empty =
    all.length === 0 ? (
      <EmptyState
        icon={Library}
        title="The library is empty"
        description="Published playbooks become reusable references here, searchable by platform, product, version, environment, task type and project - for cloud services, network devices, firewalls and security appliances, Linux and Windows systems, virtualization, databases and application infrastructure."
      />
    ) : (
      <EmptyState
        icon={SearchX}
        title="No playbooks match"
        description={status === RELEASED ? "Playbooks appear here once a revision is published. Try another status or clear the filters." : "Try a different search term or clear the filters."}
        actions={<Button onClick={clearFilters}>Clear filters</Button>}
      />
    );

  return (
    <Page title="Knowledge Library">
      <div className={list.container}>
        {playbooks.error && (
          <Notice
            tone="danger"
            role="alert"
            title="The library could not be loaded"
            action={
              <Button size="sm" onClick={playbooks.reload}>
                Retry
              </Button>
            }
          >
            {playbooks.error.message}
          </Notice>
        )}
        <div className={list.filters} role="search">
          <SearchField
            ref={searchRef}
            label="Search the library"
            placeholder="Search procedures"
            value={query}
            onValueChange={setQuery}
            className={list.search}
          />
          <Select aria-label="Filter by status" options={statusOptions} value={status} onChange={(event) => setStatus(event.target.value)} />
          <Select
            aria-label="Filter by freshness"
            options={freshnessOptions}
            value={freshness}
            onChange={(event) => setFreshness(event.target.value as Freshness)}
          />
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Reset
            </Button>
          )}
          <span className={list.count} aria-live="polite">
            {pluralize(filtered.length, "playbook")}
          </span>
        </div>
        <div className={list.facets} role="group" aria-label="Metadata filters">
          <span className={list.facetsLabel}>Filter by</span>
          {FACETS.map((facet) => {
            const options = facetOptions[facet.key];
            return (
              <Select
                key={facet.key}
                size="sm"
                aria-label={`Filter by ${facet.label.toLowerCase()}`}
                title={options.length <= 1 ? `No ${facet.label.toLowerCase()} values yet` : undefined}
                options={options}
                value={facets[facet.key]}
                disabled={options.length <= 1}
                onChange={(event) => setFacets((current) => ({ ...current, [facet.key]: event.target.value }))}
              />
            );
          })}
        </div>
        <div className={list.table}>
          <DataTable
            label="Library playbooks"
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
    </Page>
  );
}
