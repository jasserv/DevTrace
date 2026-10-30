import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router";

import { ToastProvider } from "../components";
import { ChangeHistoryPage } from "../features/changes/ChangeHistoryPage";
import { CapturePage } from "../features/capture/CapturePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { PlaybookHistoryPage } from "../features/playbooks/PlaybookHistoryPage";
import { PlaybookPage } from "../features/playbooks/PlaybookPage";
import { PlaybooksPage } from "../features/playbooks/PlaybooksPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { SessionPage } from "../features/sessions/SessionPage";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { AppShell } from "../layout/AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { AppInfoProvider, CaptureProvider, SettingsProvider } from "./providers";
import { NotFoundPage, SystemGate } from "./SystemScreens";

// Development-only route; `import.meta.env.DEV` is false in production so the chunk is not built.
const ComponentGallery = import.meta.env.DEV ? lazy(() => import("../features/dev/ComponentGallery")) : null;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<OverviewPage />} />
      <Route path="/capture" element={<CapturePage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:sessionId" element={<SessionPage />} />
      <Route path="/playbooks" element={<PlaybooksPage />} />
      <Route path="/playbooks/:playbookId" element={<PlaybookPage />} />
      <Route path="/playbooks/:playbookId/history" element={<PlaybookHistoryPage />} />
      <Route path="/changes" element={<ChangeHistoryPage />} />
      <Route path="/library" element={<LibraryPage />} />
      <Route path="/projects/:projectId?" element={<ProjectsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {ComponentGallery && (
        <Route
          path="/dev/components"
          element={
            <Suspense fallback={null}>
              <ComponentGallery />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <AppInfoProvider>
          <CaptureProvider>
            <ToastProvider>
              <HashRouter>
                <SystemGate>
                  <AppShell>
                    <AppRoutes />
                  </AppShell>
                </SystemGate>
              </HashRouter>
            </ToastProvider>
          </CaptureProvider>
        </AppInfoProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
