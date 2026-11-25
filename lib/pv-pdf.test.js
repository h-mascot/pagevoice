/**
 * lib/pv-pdf.test.js — colocated tests for the PDF import logic (issue #5)
 *
 * Runs with `node --test` (see TESTING.md). The pdf.js *vendored artifacts
 * themselves* (vendor/pdfjs/legacy/build/*.min.js, pinned in
 * vendor/pdfjs/VENDOR.md) are exercised for real — same files, same
 * main-thread-worker mechanism the offscreen document uses — so CI proves
 * the shipped bytes, not a mock.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const vm = require("node:vm");

const {
  PDF_MAX_BYTES,
  PDF_MIN_SELECTABLE_CHARS,
  PDF_ERRORS,
  validatePdfSize,
  titleFromFilename,
  hasSelectableText,
  mapPdfError,
  pdfItemsToText,
  extractPdfText,
} = require("./pv-pdf.js");

const VENDOR_DIR = path.join(__dirname, "..", "vendor", "pdfjs");
const WORKER_JS = path.join(VENDOR_DIR, "legacy", "build", "pdf.worker.min.js");
const MAIN_JS = path.join(VENDOR_DIR, "legacy", "build", "pdf.min.js");
const FIXTURES = path.join(__dirname, "..", "tests", "fixtures");

// The real pdf.js handle, loaded exactly the way offscreen.html provides
// it: worker first (main-thread WorkerMessageHandler global), then the
// main library. In Node both arrive via require(); the vm test below
// proves the *script tag* form of the same load order.
globalThis.pdfjsWorker = require(WORKER_JS);
const pdfjsLib = require(MAIN_JS);

function fixtureBytes(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

// ─── Vendoring pin ────────────────────────────────────────────────────────────

test("vendored pdf.js artifacts match the pinned SHA256 in VENDOR.md", () => {
  const vendorMd = fs.readFileSync(path.join(VENDOR_DIR, "VENDOR.md"), "utf8");
  for (const rel of ["legacy/build/pdf.min.js", "legacy/build/pdf.worker.min.js"]) {
    const sha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(VENDOR_DIR, rel)))
      .digest("hex");
    assert.ok(
      vendorMd.includes(sha),
      `${rel} sha256 ${sha} is not recorded in VENDOR.md — vendor upgraded without updating the pin?`
    );
  }
});

test("pdf.worker.min.js attaches the main-thread worker global when executed as a plain script", () => {
  // offscreen.html injects the worker file as a <script> BEFORE pdf.min.js.
  // runInThisContext reproduces exactly the UMD branch a plain script tag
  // takes (no module/exports/define), so it must attach
  // globalThis.pdfjsWorker — the handle pdf.js then prefers over spinning
  // up a real Worker (see next test).
  const before = globalThis.pdfjsWorker;
  vm.runInThisContext(fs.readFileSync(WORKER_JS, "utf8"), { timeout: 60000 });
  const after = globalThis.pdfjsWorker;
  assert.equal(typeof after, "object", "worker script must define globalThis.pdfjsWorker");
  assert.equal(typeof after.WorkerMessageHandler, "function");
  assert.notStrictEqual(after, before, "the script attached its own copy");
});

test("pdf.min.js implements the main-thread worker detection and the isEvalSupported option", () => {
  // Source-contract on the pinned build: the main library reads
  // globalThis.pdfjsWorker?.WorkerMessageHandler (main-thread mode, no
  // `new Worker` under MV3) and honors isEvalSupported (extension CSP has
  // no unsafe-eval). Guards a vendor upgrade that silently drops either.
  const mainSrc = fs.readFileSync(MAIN_JS, "utf8");
  assert.ok(mainSrc.includes("pdfjsWorker"), "main lib must read the pdfjsWorker global");
  assert.ok(mainSrc.includes("WorkerMessageHandler"));
  assert.ok(mainSrc.includes("isEvalSupported"));
});

// ─── Size guard ───────────────────────────────────────────────────────────────

test("validatePdfSize boundary values", () => {
  assert.deepStrictEqual(validatePdfSize(0), { ok: false, code: "invalid" });
  assert.deepStrictEqual(validatePdfSize(-1), { ok: false, code: "invalid" });
  assert.deepStrictEqual(validatePdfSize(NaN), { ok: false, code: "invalid" });
  assert.deepStrictEqual(validatePdfSize(1), { ok: true });
  assert.deepStrictEqual(validatePdfSize(PDF_MAX_BYTES), { ok: true });
  assert.deepStrictEqual(validatePdfSize(PDF_MAX_BYTES + 1), { ok: false, code: "too-large" });
  assert.deepStrictEqual(validatePdfSize(50 * 1024 * 1024 * 4), { ok: false, code: "too-large" });
});

// ─── Filename → title ─────────────────────────────────────────────────────────

test("titleFromFilename strips paths, extensions and separator runs", () => {
  assert.equal(titleFromFilename("Quarterly Report.pdf"), "Quarterly Report");
  assert.equal(titleFromFilename("my_great_book.PDF"), "my great book");
  assert.equal(titleFromFilename("the-lean-startup.pdf"), "the lean startup");
  assert.equal(titleFromFilename("file"), "file");
  assert.equal(titleFromFilename(""), "Untitled");
  assert.equal(titleFromFilename("   .pdf"), "Untitled");
  assert.equal(titleFromFilename("/Users/x/Downloads/deep file name.pdf"), "deep file name");
  assert.equal(titleFromFilename(null), "Untitled");
  const long = "x".repeat(200) + ".pdf";
  assert.ok(titleFromFilename(long).length <= 80);
  assert.ok(titleFromFilename(long).endsWith("…"));
});

// ─── Selectable text detection ────────────────────────────────────────────────

test("hasSelectableText threshold", () => {
  assert.equal(hasSelectableText(""), false);
  assert.equal(hasSelectableText("   \n\t  "), false);
  assert.equal(hasSelectableText("a".repeat(PDF_MIN_SELECTABLE_CHARS - 1)), false);
  assert.equal(hasSelectableText("a".repeat(PDF_MIN_SELECTABLE_CHARS)), true);
  assert.equal(hasSelectableText("  " + "word ".repeat(10)), true);
  assert.equal(hasSelectableText(null), false);
});

// ─── Error mapping ────────────────────────────────────────────────────────────

test("mapPdfError maps pdf.js exception types to operator copy", () => {
  assert.deepStrictEqual(mapPdfError({ name: "PasswordException", message: "No password given" }), {
    code: "encrypted", error: PDF_ERRORS.encrypted,
  });
  assert.deepStrictEqual(mapPdfError({ name: "InvalidPDFException", message: "Invalid PDF structure." }), {
    code: "invalid", error: PDF_ERRORS.invalid,
  });
  assert.deepStrictEqual(mapPdfError({ name: "MissingPDFException", message: "Missing PDF" }), {
    code: "invalid", error: PDF_ERRORS.invalid,
  });
  // Plain Error objects (no .name match) fall back to the message text.
  assert.equal(mapPdfError(new Error("needs a password to open")).code, "encrypted");
  assert.equal(mapPdfError(new Error("Invalid PDF structure.")).code, "invalid");
  const unknown = mapPdfError(new Error("boom"));
  assert.equal(unknown.code, "unknown");
  assert.ok(unknown.error.includes("boom"));
  assert.equal(mapPdfError(null).code, "unknown");
  assert.equal(mapPdfError("string error").code, "unknown");
});

// ─── Item joiner: synthetic positioned runs ───────────────────────────────────

function item(str, x, y, w = 20, h = 12, hasEOL = false) {
  return { str, dir: "ltr", width: w, height: h, transform: [12, 0, 0, 12, x, y], fontName: "f", hasEOL };
}

test("pdfItemsToText: same line, small gap → concatenated without space", () => {
  // font height 12 → gap threshold 12*0.2 = 2.4; gap here is 1 → no space
  const out = pdfItemsToText([item("Hel", 72, 720, 20), item("lo", 93, 720, 10)]);
  assert.equal(out, "Hello");
});

test("pdfItemsToText: same line, real gap → space inserted", () => {
  // font height 12 → gap threshold 2.4; gap here is 72→(72+40)=+40 wide open
  const out = pdfItemsToText([item("Hel", 72, 720, 40), item("lo", 130, 720, 10)]);
  assert.equal(out, "Hel lo");
});

test("pdfItemsToText: vertical move → newline", () => {
  const out = pdfItemsToText([item("Hello", 72, 720, 40), item("World", 72, 700, 40)]);
  assert.equal(out, "Hello\nWorld");
});

test("pdfItemsToText: hasEOL appends newline; empty items act as line markers", () => {
  const out = pdfItemsToText([item("Hello", 72, 720, 40, 12, true), item("World", 72, 700, 40)]);
  assert.equal(out, "Hello\nWorld");
  const blank = pdfItemsToText([{ str: "", hasEOL: true }, item("A", 72, 720, 10)]);
  assert.equal(blank, "A");
});

test("pdfItemsToText: no double newlines, edge spaces trimmed, blank runs collapsed", () => {
  const out = pdfItemsToText([
    item("one", 72, 720, 30, 12, true),
    item("", 72, 700, 0, 12, true),   // blank line marker
    { str: "", hasEOL: true },        // another blank
    item("two", 72, 660, 30, 12, true),
  ]);
  assert.equal(out, "one\n\ntwo");
});

test("pdfItemsToText: unpositioned items fall back to EOL-only joining", () => {
  const out = pdfItemsToText([
    { str: "alpha", hasEOL: true },
    { str: "beta", hasEOL: false },
  ]);
  assert.equal(out, "alpha\nbeta");
});

test("pdfItemsToText: garbage input tolerated", () => {
  assert.equal(pdfItemsToText(null), "");
  assert.equal(pdfItemsToText("nope"), "");
  assert.equal(pdfItemsToText([null, 5, { str: 7 }, { str: "ok", hasEOL: true }]), "ok");
});

// ─── Real vendored pdf.js on the committed fixtures ───────────────────────────

test("extractPdfText reads the 3-page text fixture through the vendored pdf.js", async () => {
  const progress = [];
  const res = await extractPdfText(pdfjsLib, fixtureBytes("pdf-sample.pdf"), {
    onProgress: (page, total) => progress.push([page, total]),
  });
  assert.equal(res.ok, true);
  assert.equal(res.pages, 3);
  assert.ok(res.text.includes("The quick brown fox jumps over the lazy dog."));
  assert.ok(res.text.includes("Amazingly few discotheques provide jukeboxes."));
  assert.ok(res.text.includes("Questions work too, do they not?"));
  assert.ok(res.text.includes("End of the fixture."));
  assert.deepStrictEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  // pages joined with a blank line
  assert.ok(res.text.includes(".\n\nSecond page"));
});

test("extracted PDF text chunks through the existing playback pipeline", async () => {
  const { buildTextChunks } = require("./pv-utils.js");
  const res = await extractPdfText(pdfjsLib, fixtureBytes("pdf-sample.pdf"));
  assert.equal(res.ok, true);
  // Edge-engine chunk size (lib/pv-shortcuts.js engineChunkLen("edge") = 8
  // sentences): 18 fixture lines are all full sentences → multiple chunks,
  // first chunk starts with the first sentence.
  const chunks = buildTextChunks(res.text, 300);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  assert.ok(chunks[0].text.startsWith("PageVoice PDF import fixture."));
  const all = chunks.map((c) => c.text).join(" ");
  assert.ok(all.includes("do they not?"), "last-page sentence survived chunking");
});

test("extractPdfText reports no-text for the image-only (scanned) fixture", async () => {
  const res = await extractPdfText(pdfjsLib, fixtureBytes("pdf-image-only.pdf"));
  assert.equal(res.ok, false);
  assert.equal(res.code, "no-text");
  assert.equal(res.error, PDF_ERRORS["no-text"]);
});

test("extractPdfText reports invalid for corrupt/garbage bytes", async () => {
  const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39, 0x39, 0x40, 0x40, 0x40, 0x40, 0x40]);
  const res = await extractPdfText(pdfjsLib, garbage);
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid");
});

test("extractPdfText maps PasswordException from a pdf.js-shaped failure", async () => {
  const fakeLib = {
    getDocument: () => ({ promise: Promise.reject({ name: "PasswordException", message: "No password given" }) }),
  };
  const res = await extractPdfText(fakeLib, fixtureBytes("pdf-sample.pdf"));
  assert.equal(res.ok, false);
  assert.equal(res.code, "encrypted");
  assert.equal(res.error, PDF_ERRORS.encrypted);
});

test("extractPdfText guards size and missing library without touching pdf.js", async () => {
  const empty = await extractPdfText(pdfjsLib, new ArrayBuffer(0));
  assert.equal(empty.code, "invalid");

  const oversized = new Uint8Array(PDF_MAX_BYTES + 1); // real 50 MB + 1 bytes
  const tooBig = await extractPdfText(pdfjsLib, oversized);
  assert.equal(tooBig.code, "too-large");
  assert.equal(tooBig.error, PDF_ERRORS["too-large"]);

  const noLib = await extractPdfText(null, fixtureBytes("pdf-sample.pdf"));
  assert.equal(noLib.code, "load-failed");
  assert.equal(noLib.error, PDF_ERRORS["load-failed"]);
});
