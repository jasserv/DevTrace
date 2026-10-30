import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Button, Icon } from "../components";
import styles from "./SystemScreens.module.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence for unexpected interface errors: instead of a blank window, it says what
 * happened and offers to reload. Saved data lives in the backend and is not affected.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("DevTrace interface error", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className={styles.screen}>
        <div className={styles.panel} role="alert">
          <Icon icon={TriangleAlert} size={28} className={styles.icon} />
          <h1 className={styles.title}>Something went wrong in this window</h1>
          <p className={styles.text}>
            Everything you saved is kept in the workspace. Reload the window to continue; text typed into an open dialog may need to be
            entered again.
          </p>
          <div className={styles.detail}>{error.message || "Unknown error"}</div>
          <div className={styles.actions}>
            <Button variant="primary" icon={RotateCw} onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </main>
    );
  }
}
