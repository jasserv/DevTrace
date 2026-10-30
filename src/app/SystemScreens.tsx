import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { DatabaseZap, FolderOpen, MonitorX, RotateCw, SearchX } from "lucide-react";

import { Button, EmptyState, Icon } from "../components";
import { Page } from "../layout/Page";
import { api } from "../lib/api";
import { revealLabel } from "../lib/platform";
import { useAppInfo } from "./contexts";
import styles from "./SystemScreens.module.css";

/**
 * Replaces the workspace UI when the app cannot work at all: the desktop runtime is missing
 * (opened in a plain browser) or the local database failed to open. Everything else renders.
 */
export function SystemGate({ children }: { children: ReactNode }) {
  const appInfo = useAppInfo();

  if (appInfo.error?.kind === "runtime_unavailable") {
    return (
      <SystemScreen icon={MonitorX} title="DevTrace needs its desktop runtime">
        <p className={styles.text}>
          This interface is running in a regular browser, where the local database and capture services are not available.
          Start the desktop app instead:
        </p>
        <code className={styles.detail}>npm run tauri dev</code>
      </SystemScreen>
    );
  }

  const info = appInfo.data;
  if (info && !info.storageReady) {
    return (
      <SystemScreen icon={DatabaseZap} title="DevTrace could not open its local database">
        <p className={styles.text}>
          Your data has not been modified. If this workspace was created by a newer version of DevTrace, update the app. Otherwise
          check that the folder below is accessible.
        </p>
        <div className={styles.detail}>{info.storageError ?? "Unknown error"}</div>
        <div className={styles.detail}>{info.dataDir}</div>
        <div className={styles.actions}>
          <Button icon={FolderOpen} onClick={() => void api.app.revealDataDirectory().catch(() => undefined)}>
            {revealLabel}
          </Button>
          <Button icon={RotateCw} onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </SystemScreen>
    );
  }

  return <>{children}</>;
}

function SystemScreen({ icon, title, children }: { icon: typeof DatabaseZap; title: string; children: ReactNode }) {
  return (
    <main className={styles.screen}>
      <div className={styles.panel} role="alert">
        <Icon icon={icon} size={28} className={styles.icon} />
        <h1 className={styles.title}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Page title="Not found">
      <EmptyState
        icon={SearchX}
        title="This page does not exist"
        description="The link may be outdated. Use the sidebar or return to the Overview."
        actions={
          <Button variant="primary" onClick={() => navigate("/overview")}>
            Go to Overview
          </Button>
        }
      />
    </Page>
  );
}
