import { useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";

import { Button, Dialog, Notice, SegmentedControl, Select, useToast } from "../../components";
import { api, toApiError, type ExportFormat, type ExportResult, type PlaybookDetail } from "../../lib/api";
import { formatBytes, pluralize } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import styles from "./ExportDialog.module.css";
import { CURRENT_VERSION, exportVersionOptions } from "./playbookModel";

const FORMATS: Record<ExportFormat, { label: string; description: string }> = {
  markdown: {
    label: "Markdown",
    description: "A .md file with an images folder, for Git repositories, wikis and text editors.",
  },
  html: {
    label: "HTML",
    description: "One self-contained .html file with the screenshots embedded. Opens in any browser and contains no scripts.",
  },
  pdf: {
    label: "PDF",
    description: "A printable document made from the HTML export, on A4 or Letter paper (from your Windows region settings) with page numbers.",
  },
};

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  detail: PlaybookDetail;
  /** Saves pending edits before the working copy is exported; resolves false when that failed. */
  beforeExport: () => Promise<boolean>;
  /** Version to preselect (a revision id or the working copy); the first option otherwise. */
  initialVersion?: string;
}

/**
 * Exports one version of a playbook as Markdown, HTML or PDF into the workspace exports folder,
 * then offers to show the file. Unpublished versions are labeled as such inside the export.
 */
export function ExportDialog({ open, onClose, detail, beforeExport, initialVersion }: ExportDialogProps) {
  const toast = useToast();
  const info = useResource(api.app.info);
  const options = useMemo(() => exportVersionOptions(detail), [detail]);
  const [version, setVersion] = useState(() => initialVersion ?? options[0]?.value ?? CURRENT_VERSION);
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const selected = options.some((option) => option.value === version) ? version : (options[0]?.value ?? CURRENT_VERSION);

  const pdfUnavailable =
    format === "pdf" && info.data && !info.data.pdfExportSupported ? "PDF export is only available on Windows in this version." : undefined;

  const close = () => {
    if (busy) return;
    setError(null);
    setResult(null);
    onClose();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (selected === CURRENT_VERSION && !(await beforeExport())) {
        setError("The latest changes could not be saved, so they would be missing from the export. Fix the problem shown in the toolbar, then try again.");
        return;
      }
      setResult(await api.exports.playbook(detail.id, format, selected === CURRENT_VERSION ? null : selected));
    } catch (raw) {
      setError(toApiError(raw).message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (exported: ExportResult) => {
    try {
      await api.exports.reveal(exported.relativePath);
    } catch (raw) {
      toast.error("The file could not be shown", toApiError(raw).message);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={result ? "Export complete" : "Export playbook"}
      dismissible={!busy}
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>Export another</Button>
            <Button icon={FolderOpen} onClick={() => void reveal(result)}>
              Show in folder
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run()} loading={busy} disabledReason={pdfUnavailable}>
              Export
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className={styles.form}>
          <Notice tone="success" role="status" title={`Exported ${result.fileName}`}>
            {`${result.versionLabel} \u00b7 ${pluralize(result.imageCount, "screenshot")} \u00b7 ${formatBytes(result.byteSize)}`}
          </Notice>
          {result.missingImages > 0 && (
            <Notice tone="warning" title={`${pluralize(result.missingImages, "screenshot")} could not be included`}>
              Their files are missing from the workspace folder. The export marks where they belong.
            </Notice>
          )}
          <div>
            <p className={styles.pathLabel}>Saved in the workspace exports folder</p>
            <p className={styles.path}>{result.path}</p>
          </div>
        </div>
      ) : (
        <div className={styles.form}>
          <Select label="Version" options={options} value={selected} onChange={(event) => setVersion(event.target.value)} />
          <SegmentedControl<ExportFormat>
            label="Format"
            value={format}
            onChange={(next) => {
              setFormat(next);
              setError(null);
            }}
            options={(Object.keys(FORMATS) as ExportFormat[]).map((value) => ({ value, label: FORMATS[value].label }))}
          />
          <p className={styles.hint}>{pdfUnavailable ?? FORMATS[format].description}</p>
          <p className={styles.hint}>
            Files are saved in the exports folder of your workspace. Screenshots keep their redactions and highlights; stored evidence is not changed.
          </p>
          {error && (
            <Notice tone="danger" role="alert" title="The playbook could not be exported">
              {error}
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}
