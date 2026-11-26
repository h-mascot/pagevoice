#!/usr/bin/env node
// Verify a packaged store zip contains every script/style the runtime
// references (manifest content scripts + background worker, importScripts
// calls, html script/link tags, web_accessible_resources, icons).
//
// Why: v2.2.2's first build silently omitted lib/pv-transport.js while
// offscreen.html and the manifest referenced it — the extension would have
// loaded with a broken PDF path. package-zip.sh now runs this guard after
// zipping so a new runtime file can never be left out again.
//
// Usage: node scripts/verify-zip-contents.js <zip>   (run from repo root)
"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

const zip = process.argv[2];
if (!zip) {
  console.error("usage: node scripts/verify-zip-contents.js <zip>");
  process.exit(2);
}

const entries = new Set(
  execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
);

const missing = [];
const add = (ref, why) => {
  if (!entries.has(ref)) missing.push(`${ref}  (${why})`);
};

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
for (const cs of manifest.content_scripts || []) {
  for (const j of cs.js || []) add(j, "manifest content_scripts js");
  for (const c of cs.css || []) add(c, "manifest content_scripts css");
}
if (manifest.background && manifest.background.service_worker) {
  add(manifest.background.service_worker, "manifest background.service_worker");
}
for (const war of manifest.web_accessible_resources || []) {
  for (const r of war.resources || []) if (!r.includes("*")) add(r, "web_accessible_resources");
}
for (const [size, rel] of Object.entries(manifest.icons || {})) add(rel, `manifest icon ${size}`);

// Only scan files that are actually in the zip — a reference from a file
// that itself failed to ship is caught by the manifest/entry checks above.
const readIf = (f) => (entries.has(f) ? fs.readFileSync(f, "utf8") : "");
for (const f of ["background.js", "offscreen.js", "content.js", "popup.js"]) {
  const src = readIf(f);
  for (const m of src.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) add(q[1], `importScripts in ${f}`);
  }
}
for (const f of ["offscreen.html", "popup.html"]) {
  const src = readIf(f);
  for (const m of src.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) add(m[1], `script src in ${f}`);
  for (const m of src.matchAll(/<link[^>]*\bhref=["']([^"']+)["']/g)) {
    if (!/^https?:/.test(m[1])) add(m[1], `stylesheet href in ${f}`);
  }
}

if (missing.length) {
  console.error("verify-zip: MISSING from zip:\n  " + missing.join("\n  "));
  process.exit(1);
}
console.log(`verify-zip: all runtime references present (${entries.size} zip entries)`);
