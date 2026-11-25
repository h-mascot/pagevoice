/**
 * lib/pv-pdf.js — PageVoice PDF import pure logic (issue #5)
 *
 * Everything testable about "open a PDF and read it aloud" lives here:
 * size guarding, filename → title, pdf.js text-item joining (the hard
 * part: turning positioned runs into readable prose), selectable-text
 * detection, error mapping, and the extraction driver `extractPdfText`.
 * The driver takes a pdfjsLib handle + raw bytes and works identically in
 * the Node tests (required from vendor/pdfjs, main-thread worker) and in
 * the offscreen document (script tags, see vendor/pdfjs/VENDOR.md) — so
 * CI exercises the exact shipped artifacts.
 *
 * Loading (no build step, MV3-safe): offscreen.html script-tags this file
 * and background.js importScripts()s it, so top-level declarations become
 * globals in both. The Node export block at the bottom is inert there.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const PDF_MAX_BYTES = 50 * 1024 * 1024; // issue #5: refuse files over 50 MB
const PDF_MIN_SELECTABLE_CHARS = 24;    // non-whitespace chars a real text PDF yields
const PDF_TITLE_MAX_CHARS = 80;

// Operator-facing copy for every failure mode. One source, reused by the
// offscreen handler, background, and tests.
const PDF_ERRORS = {
  "too-large":   "PDF is larger than 50 MB — please use a smaller file.",
  "encrypted":   "This PDF is password-protected. Remove the password and try again.",
  "no-text":     "No selectable text found — this PDF may be a scan. Try a text-based PDF.",
  "invalid":     "This file doesn't look like a valid PDF.",
  "load-failed": "The PDF reader failed to load. Reload the extension and try again.",
  "unknown":     "PDF import failed.",
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function validatePdfSize(byteLength) {
  const n = Number(byteLength);
  const ok = Number.isFinite(n) && n > 0 && n <= PDF_MAX_BYTES;
  if (!ok) {
    return { ok: false, code: n > PDF_MAX_BYTES ? "too-large" : "invalid" };
  }
  return { ok: true };
}

// "Quarterly Report.pdf" → "Quarterly Report"; "my_great_book.PDF" →
// "my great book". Falls back to "Untitled" for empty/pathological names.
function titleFromFilename(name) {
  const raw = typeof name === "string" ? name : "";
  let base = raw.split(/[\\/]/).pop() || "";          // drop any path segments
  base = base.replace(/\.pdf$/i, "");                 // drop one extension
  base = base.replace(/[._-]+/g, " ");                // separators → spaces
  base = base.replace(/\s+/g, " ").trim();
  if (!base) return "Untitled";
  if (base.length > PDF_TITLE_MAX_CHARS) base = base.slice(0, PDF_TITLE_MAX_CHARS - 1).trimEnd() + "…";
  return base;
}

// A document "has selectable text" when enough non-whitespace characters
// survive extraction. Scanned PDFs yield a few stray glyph codes at most.
function hasSelectableText(text) {
  const bare = (typeof text === "string" ? text : "").replace(/\s+/g, "");
  return bare.length >= PDF_MIN_SELECTABLE_CHARS;
}

// pdf.js error objects → { code, error } with operator-facing copy.
function mapPdfError(err) {
  const name = (err && err.name) || "";
  const message = String((err && err.message) || err || "");
  if (name === "PasswordException" || /password/i.test(name) || /password/i.test(message)) {
    return { code: "encrypted", error: PDF_ERRORS.encrypted };
  }
  if (name === "InvalidPDFException" || name === "MissingPDFException" ||
      /invalid pdf structure|missing pdf/i.test(message)) {
    return { code: "invalid", error: PDF_ERRORS.invalid };
  }
  return { code: "unknown", error: PDF_ERRORS.unknown + (message ? ` (${message.slice(0, 120)})` : "") };
}

// ─── pdf.js text items → readable text (the joiner) ──────────────────────────
//
// pdf.js hands back positioned runs: { str, width, height, transform, hasEOL }.
// `transform` is the text matrix [a, b, c, d, e, f]: x = e, y = f. Rebuilding
// prose means deciding, for every run, whether it continues the line
// (concat, maybe with a gap-space), starts a new line, or is an empty
// newline marker. Only x/y/width/height are used — pure, no DOM.

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// Normalise one item to { str, hasEOL, x, y, w, h, positioned } —
// `positioned` false when the item carries no usable transform (tests,
// odd producers): the joiner then falls back to hasEOL-only.
function normalizePdfItem(item) {
  if (!item || typeof item.str !== "string") return null;
  const t = Array.isArray(item.transform) ? item.transform : null;
  const positioned = t && t.length >= 6 &&
    isFiniteNumber(t[4]) && isFiniteNumber(t[5]) &&
    isFiniteNumber(item.width) && isFiniteNumber(item.height);
  return {
    str: item.str,
    hasEOL: Boolean(item.hasEOL),
    x: positioned ? t[4] : 0,
    y: positioned ? t[5] : 0,
    w: positioned ? Math.abs(item.width) : 0,
    h: positioned ? Math.abs(item.height) || 10 : 10,
    positioned,
  };
}

function pdfItemsToText(items) {
  if (!Array.isArray(items)) return "";
  let out = "";
  let prev = null; // last positioned item seen

  for (const raw of items) {
    const item = normalizePdfItem(raw);
    if (!item) continue;

    if (item.str === "") {
      // pdf.js emits empty runs purely as line markers. Unlike text runs,
      // these accumulate: "one"(EOL) + blank(EOL) + "two" is a real blank
      // line, so the marker always appends (the final pass collapses runs).
      if (item.hasEOL) out += "\n";
      continue;
    }

    if (prev && prev.positioned && item.positioned) {
      const dy = Math.abs(item.y - prev.y);
      if (dy > prev.h * 0.5) {
        // moved to a new line
        if (!out.endsWith("\n")) out += "\n";
      } else {
        // same line: insert a space when there is a real horizontal gap
        // (font height ≈ 1 em; a space advances ~0.25–0.33 em) and neither
        // side already carries one.
        const gap = item.x - (prev.x + prev.w);
        if (gap > prev.h * 0.2 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
          out += " ";
        }
      }
    } else if (prev && !out.endsWith("\n") && !/\s$/.test(out) && !/^\s/.test(item.str)) {
      // Unpositioned items: no gap info — only avoid gluing words when a
      // line break is not already present.
      if (item.hasEOL === false && prev.hasEOL === false) out += " ";
    }

    out += item.str;
    if (item.hasEOL && !out.endsWith("\n")) out += "\n";
    prev = item;
  }

  // Cosmetic pass: trim line-edge spaces, collapse blank-line runs.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Extraction driver ───────────────────────────────────────────────────────
//
// extractPdfText(pdfjsLib, data, opts) →
//   { ok: true,  text, pages }
//   { ok: false, code, error }   code ∈ PDF_ERRORS keys
//
// `data`: ArrayBuffer or TypedArray of the raw PDF bytes.
// `opts.onProgress(page, total)`: optional, called after each page.
// Runs pdf.js on the current thread (the offscreen document supplies the
// main-thread worker via the pdfjsWorker global; Node tests inject it the
// same way) — no Worker is constructed, so nothing here can be torn down
// by the MV3 service worker lifecycle.

async function extractPdfText(pdfjsLib, data, opts = {}) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== "function") {
    return { ok: false, code: "load-failed", error: PDF_ERRORS["load-failed"] };
  }

  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const byteLength = bytes && bytes.byteLength;
  const sizeCheck = validatePdfSize(byteLength);
  if (!sizeCheck.ok) {
    return { ok: false, code: sizeCheck.code, error: PDF_ERRORS[sizeCheck.code] };
  }

  let doc = null;
  try {
    doc = await pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false, // extension CSP has no unsafe-eval
      verbosity: 0,           // keep test/offscreen output quiet
    }).promise;

    const pageTexts = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      pageTexts.push(pdfItemsToText(content.items));
      if (typeof opts.onProgress === "function") {
        try { opts.onProgress(pageNum, doc.numPages); } catch (_) { /* progress is best-effort */ }
      }
    }

    const text = pageTexts.map((s) => s.trim()).filter(Boolean).join("\n\n");
    if (!hasSelectableText(text)) {
      return { ok: false, code: "no-text", error: PDF_ERRORS["no-text"] };
    }
    return { ok: true, text, pages: doc.numPages };
  } catch (err) {
    const mapped = mapPdfError(err);
    return { ok: false, code: mapped.code, error: mapped.error };
  } finally {
    if (doc && typeof doc.destroy === "function") {
      try { await doc.destroy(); } catch (_) { /* already torn down */ }
    }
  }
}

// ─── Node test-runner export (inert in the extension) ───────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PDF_MAX_BYTES,
    PDF_MIN_SELECTABLE_CHARS,
    PDF_ERRORS,
    validatePdfSize,
    titleFromFilename,
    hasSelectableText,
    mapPdfError,
    normalizePdfItem,
    pdfItemsToText,
    extractPdfText,
  };
}
