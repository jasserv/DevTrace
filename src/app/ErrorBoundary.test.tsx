import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("Cannot read properties of undefined (reading 'title')");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders its children when nothing fails", () => {
    render(
      <ErrorBoundary>
        <p>Workspace</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("replaces a crashed interface with an explanation and a reload action", () => {
    // React reports caught render errors on the console; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong in this window");
    expect(alert).toHaveTextContent("Everything you saved is kept in the workspace.");
    expect(alert).toHaveTextContent("reading 'title'");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
