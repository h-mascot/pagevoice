/**
 * lib/pv-transport.js — byte-safe PDF transport over chrome.runtime messages
 * (issue #20, verification round 2)
 *
 * WHY THIS EXISTS: chrome.runtime.sendMessage does not preserve ArrayBuffer
 * across the hop (the message is JSON-serialized: an ArrayBuffer arrives as
 * a plain empty object, so `instanceof ArrayBuffer` fails downstream). The
 * v2.2.1 PDF import sent { buffer, name } and died end-to-end on BOTH entry
 * paths with "No PDF data received" — green pure-logic tests missed it
 * because the real channel semantics were never exercised. The transport
 * now carries base64 STRING chunks, which survive the channel verbatim.
 *
 * Protocol (sender → background):
 *   pdfImportBegin  { name, totalBytes, chunkCount }  → { ok, sessionId }
 *   pdfImportChunk  { sessionId, index, b64 }          → { ok, received }
 *   pdfImportEnd    { sessionId }                      → final import result
 * (background → offscreen mirrors it as pdf-extract-begin/chunk/end, since
 * the background↔offscreen hop has the same serialization semantics.)
 *
 * Chunk size 2 MiB raw (≈2.8 MiB as base64): a 50 MB PDF — the size guard —
 * stays well under any single-message limit at 25 messages instead of one
 * 67 MB string, and JSON (de)serialization per message stays cheap.
 *
 * Kept pure (plus a channel-agnostic sendPdfImportViaChannel driver) so it
 * is unit-testable with node --test per TESTING.md; the only environment
 * surface is btoa/atob with Node Buffer fallbacks for the test runner.
 * Loading: classic <script>/importScripts before the callers; the Node
 * export block at the bottom is inert in the browser.
 */

// Raw bytes per transport chunk.
const PDF_TRANSPORT_CHUNK_BYTES = 2 * 1024 * 1024;

// btoa/atob with Node fallbacks (test runner) — identical output either way.
function b64EncodeBinary(bin) {
  if (typeof btoa === "function") return btoa(bin);
  if (typeof Buffer !== "undefined" && Buffer.from) {
    return Buffer.from(bin, "binary").toString("base64");
  }
  throw new Error("no base64 encoder available");
}

function b64DecodeToBinary(b64) {
  if (typeof atob === "function") return atob(b64);
  if (typeof Buffer !== "undefined" && Buffer.from) {
    return Buffer.from(b64, "base64").toString("binary");
  }
  throw new Error("no base64 decoder available");
}

// Uint8Array → base64 (stack-safe: 32 KB slices, never a mega argument).
function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = "";
  const SLICE = 0x8000;
  for (let k = 0; k < view.length; k += SLICE) {
    const end = Math.min(k + SLICE, view.length);
    bin += String.fromCharCode.apply(null, view.subarray(k, end));
  }
  return b64EncodeBinary(bin);
}

// base64 → fresh Uint8Array (byte-exact).
function base64ToBytes(b64) {
  const bin = b64DecodeToBinary(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k) & 0xff;
  return out;
}

// Split raw bytes into base64 chunk strings (PDF_TRANSPORT_CHUNK_BYTES each).
function pdfTransportChunks(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const chunks = [];
  for (let k = 0; k < view.length; k += PDF_TRANSPORT_CHUNK_BYTES) {
    chunks.push(bytesToBase64(view.subarray(k, Math.min(k + PDF_TRANSPORT_CHUNK_BYTES, view.length))));
  }
  return chunks;
}

// ─── Receiver-side session (shared by background and offscreen) ─────────────

// A fresh receive session. The receiver owns GC (a timer clearing the entry
// after PDF_TRANSPORT_SESSION_MS without End — a popup that died mid-send
// must not leak sessions).
function makePdfTransportSession() {
  return {
    chunks: new Map(), // index → base64 string
    received: 0,
    createdAt: Date.now(),
  };
}

// Strict payload validation for pdfImportBegin (and pdf-extract-begin):
// { name: string, totalBytes: positive integer, chunkCount: positive int }.
function isValidPdfTransportBegin(payload) {
  return Boolean(payload) &&
    typeof payload.name === "string" &&
    payload.name.length <= 512 &&
    Number.isInteger(payload.totalBytes) &&
    payload.totalBytes > 0 &&
    Number.isInteger(payload.chunkCount) &&
    payload.chunkCount > 0 &&
    payload.chunkCount * PDF_TRANSPORT_CHUNK_BYTES >= payload.totalBytes &&
    (payload.chunkCount - 1) * PDF_TRANSPORT_CHUNK_BYTES < payload.totalBytes;
}

// Add a chunk to a session. Validates shape (index in range, b64 string,
// not a duplicate). Returns true when stored.
function pdfSessionAddChunk(session, payload) {
  if (!session || !payload) return false;
  if (!Number.isInteger(payload.index) || payload.index < 0) return false;
  if (typeof payload.b64 !== "string" || payload.b64.length === 0) return false;
  if (session.chunks.has(payload.index)) return false; // duplicate — reject
  session.chunks.set(payload.index, payload.b64);
  session.received += 1;
  return true;
}

// Assemble a completed session: all chunkCount chunks present, decoded
// total length matches totalBytes. Returns Uint8Array or null (never a
// partial buffer — a mismatch is a protocol error, not a truncation).
function pdfSessionAssemble(session, totalBytes, chunkCount) {
  if (!session) return null;
  if (session.chunks.size !== chunkCount) return null;
  const parts = [];
  let total = 0;
  for (let k = 0; k < chunkCount; k++) {
    const b64 = session.chunks.get(k);
    if (typeof b64 !== "string") return null;
    const part = base64ToBytes(b64);
    total += part.length;
    if (total > totalBytes) return null;
    parts.push(part);
  }
  if (total !== totalBytes) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ─── Sender-side driver (channel-agnostic; works in popup and content
// script contexts). `send(message)` must resolve to the response object or
// null (channel error). Returns the final import result object.
async function sendPdfImportViaChannel(file, send) {
  const name = typeof file?.name === "string" ? file.name : "";
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (_) {
    return { ok: false, error: "Could not read the file — try again." };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "No PDF data received — pick the file again." };
  }
  const chunks = pdfTransportChunks(bytes);

  const begin = await send({
    target: "background",
    type: "pdfImportBegin",
    payload: { name, totalBytes: bytes.length, chunkCount: chunks.length },
  });
  if (!begin || !begin.ok || !begin.sessionId) {
    return (begin && begin.ok === false && begin.error)
      ? begin
      : { ok: false, error: "Import failed — the extension did not respond. Try again." };
  }
  const sessionId = begin.sessionId;

  for (let k = 0; k < chunks.length; k++) {
    const res = await send({
      target: "background",
      type: "pdfImportChunk",
      payload: { sessionId, index: k, b64: chunks[k] },
    });
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || "PDF transfer was interrupted — pick the file again." };
    }
  }

  const done = await send({
    target: "background",
    type: "pdfImportEnd",
    payload: { sessionId },
  });
  return done || { ok: false, error: "Import failed — the extension did not respond. Try again." };
}

// ─── Node test-runner export (inert in the browser) ─────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PDF_TRANSPORT_CHUNK_BYTES,
    bytesToBase64,
    base64ToBytes,
    pdfTransportChunks,
    makePdfTransportSession,
    isValidPdfTransportBegin,
    pdfSessionAddChunk,
    pdfSessionAssemble,
    sendPdfImportViaChannel,
  };
}
