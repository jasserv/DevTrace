#!/usr/bin/env node
// Enforces the design-token rule: literal colors and corner radii may only appear in
// src/styles/tokens.css. Every other stylesheet and component must use CSS variables.
//
// Flags, outside tokens.css:
//   - hex colors (#fff, #1d1d1f, #00000080)
//   - rgb()/rgba()/hsl()/hsla() literals
//   - border-radius values that are not var(...), 0 or 50%
//   - inline style colors in TSX (color/background with literal values)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const srcDir = join(root, "src");
const allowed = new Set([join("src", "styles", "tokens.css")]);
// Development-only gallery: its sample screenshot is an inline SVG with literal colors.
const excludedDirs = [join("src", "features", "dev")];

const patterns = [
  { name: "hex color", regex: /(?<![\w&-])#[0-9a-fA-F]{3,8}\b/g },
  { name: "color function", regex: /\b(?:rgba?|hsla?)\(/g },
  // Whitespace is matched inside the lookahead so backtracking cannot skip past "var(".
  { name: "raw border-radius", regex: /border(?:-[a-z]+)*-radius\s*:(?!\s*(?:var\(|0\s*;|50%|inherit))[^;]+;/g },
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...walk(full));
    else if (/\.(css|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

function stripComments(text, isCss) {
  if (isCss) return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

const violations = [];
for (const file of walk(srcDir)) {
  const rel = relative(root, file);
  if (allowed.has(rel)) continue;
  if (excludedDirs.some((dir) => rel.startsWith(dir + sep))) continue;
  const isCss = file.endsWith(".css");
  // Test files may use literal values in assertions.
  if (/\.test\.tsx$/.test(file)) continue;
  const text = stripComments(readFileSync(file, "utf8"), isCss);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { name, regex } of patterns) {
      if (!isCss && name === "raw border-radius") continue;
      regex.lastIndex = 0;
      if (!isCss && name === "hex color") {
        // In TSX only flag hex values inside quotes (style values), not ids like href="#main".
        const quoted = /["'`]#[0-9a-fA-F]{3,8}["'`]/;
        if (quoted.test(line)) violations.push({ rel, line: index + 1, name, text: line.trim() });
        continue;
      }
      if (regex.test(line)) violations.push({ rel, line: index + 1, name, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(`Design token check failed (${violations.length} issue(s)). Use variables from src/styles/tokens.css:\n`);
  for (const v of violations) {
    console.error(`  ${v.rel.split(sep).join("/")}:${v.line}  ${v.name}  ${v.text}`);
  }
  process.exit(1);
}
console.log("Design token check passed: no literal colors or radii outside tokens.css.");
