#!/usr/bin/env node
// Checks that the application's command permissions stay consistent (run by `npm run lint`):
// every command registered in src-tauri/src/lib.rs (`generate_handler!`) is listed in
// src-tauri/build.rs (the app manifest that generates `allow-<command>` permissions) and allowed
// by the main window's capability, and nothing else is.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const handlerBlock = /generate_handler!\[([\s\S]*?)\]/.exec(read("src-tauri/src/lib.rs"))?.[1] ?? "";
const registered = handlerBlock
  .split(",")
  .map((entry) => entry.trim().split("::").pop())
  .filter(Boolean);

const manifestBlock = /const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(read("src-tauri/build.rs"))?.[1] ?? "";
const manifest = [...manifestBlock.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);

const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
const allowed = capability.permissions
  .filter((permission) => typeof permission === "string" && permission.startsWith("allow-"))
  .map((permission) => permission.slice("allow-".length).replaceAll("-", "_"));

const problems = [];
const compare = (name, left, right, leftName, rightName) => {
  for (const command of left) if (!right.includes(command)) problems.push(`${name}: "${command}" is in ${leftName} but not in ${rightName}`);
};
const duplicates = (list, name) => {
  const seen = new Set();
  for (const command of list) {
    if (seen.has(command)) problems.push(`"${command}" is listed twice in ${name}`);
    seen.add(command);
  }
};

if (registered.length === 0) problems.push("No commands found in generate_handler! (src-tauri/src/lib.rs)");
duplicates(registered, "lib.rs");
duplicates(manifest, "build.rs");
duplicates(allowed, "capabilities/default.json");
compare("manifest", registered, manifest, "lib.rs", "build.rs");
compare("manifest", manifest, registered, "build.rs", "lib.rs");
compare("capability", registered, allowed, "lib.rs", "capabilities/default.json");
compare("capability", allowed, registered, "capabilities/default.json", "lib.rs");
if (JSON.stringify(capability.windows) !== JSON.stringify(["main"])) problems.push('The main-window capability must apply to ["main"] only.');

if (problems.length > 0) {
  console.error(`Command permission check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Command permission check passed: ${registered.length} commands registered, listed in the app manifest and allowed for the main window only.`);
