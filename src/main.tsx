import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import { App } from "./app/App";
import { revealWindow } from "./lib/platform";

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root is missing from index.html");

// Native file drop handling is disabled (tauri.conf.json) so drop zones receive HTML5 events.
// A file dropped anywhere else must not make the webview navigate to it.
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The native window starts hidden (tauri.conf.json) so the saved theme is applied before
// anything is visible. Reveal it after the first frame has been painted.
requestAnimationFrame(() => requestAnimationFrame(() => void revealWindow()));
