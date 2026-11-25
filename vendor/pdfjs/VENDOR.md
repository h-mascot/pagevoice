# Vendored pdf.js — PDF text extraction (issue #5)

PageVoice has no build step and MV3 forbids remote code, so the pdf.js
artifacts used for `pdfImport` are vendored here at a **pinned version**.

- **Library:** pdf.js (pdfjs-dist) — Mozilla, Apache-2.0 (see `LICENSE`)
- **Version:** 3.11.174 (final 3.x release; the `legacy/` UMD builds are the
  last generation that runs as plain classic scripts — required because
  PageVoice's extension pages load everything via `<script src=...>` /
  dynamic script injection, no bundler, no ESM)
- **Source tarball:** https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-3.11.174.tgz

## Files & SHA256

| file | sha256 |
|---|---|
| `legacy/build/pdf.min.js` | `978fd1b2d134a98e98966186a97777bebf87d8e770dadab1ece3687e21a5aa6c` |
| `legacy/build/pdf.worker.min.js` | `38cde5311957b86bc3669f93e7d2566de333a90055ed6635bef60d9bf00e96f2` |
| `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

## How it loads (MV3-safe)

`pdf.worker.min.js` is loaded as a **plain script tag** (dynamically, only on
first PDF import) BEFORE `pdf.min.js`. As scripts they set the globals
`window.pdfjsWorker` and `window.pdfjsLib`. pdf.js detects
`globalThis.pdfjsWorker.WorkerMessageHandler` and then runs the worker **on
the main thread of the offscreen document** — no `new Worker()` construction,
no `import()`, no `workerSrc` fetch: everything stays same-origin under the
extension's default CSP (`script-src 'self'`), and no Worker lifetime can be
killed by the MV3 service worker.

The Node colocated tests (`lib/pv-pdf.test.js`) load the exact same two
files via `require()` + `globalThis.pdfjsWorker` injection, so CI exercises
the shipped artifacts byte-for-byte.

`getDocument` is always called with `isEvalSupported: false` (the extension
CSP has no `unsafe-eval`) and `cMapUrl` is intentionally NOT configured —
see README "Limitations" (CJK PDFs with non-embedded CID fonts may extract
poorly until cmaps are vendored in a follow-up).

## Upgrading

1. Download the new `pdfjs-dist` tarball, copy the two `legacy/build`
   `*.min.js` files over these, update the version + SHA256 table above.
2. Run `npm test` — the fixture tests in `lib/pv-pdf.test.js` verify the
   whole extraction pipeline against the new build.
3. 4.x+ dropped classic UMD builds (ESM-only even in `legacy/`); staying on
   3.x is deliberate until PageVoice adopts a module-based page.
