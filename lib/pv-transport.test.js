/**
 * lib/pv-transport.test.js — colocated tests for the byte-safe PDF
 * transport (issue #20, verification round 2).
 *
 * Run: `npm test` (node --test). The round-2 lesson is encoded here as a
 * first-class assertion: chrome.runtime.sendMessage JSON-serializes
 * messages, so an ArrayBuffer payload does NOT survive the hop — the
 * channel-semantics tests below round-trip every message through
 * JSON.parse(JSON.stringify(msg)) (the semantics that broke v2.2.1) and
 * require byte-exact delivery anyway.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  PDF_TRANSPORT_CHUNK_BYTES,
  bytesToBase64,
  base64ToBytes,
  pdfTransportChunks,
  makePdfTransportSession,
  isValidPdfTransportBegin,
  pdfSessionAddChunk,
  pdfSessionAssemble,
  sendPdfImportViaChannel,
} = require("./pv-transport.js");

const rand = (n) => new Uint8Array(crypto.randomBytes(n));

// The REAL chrome.runtime.sendMessage serialization semantics: messages are
// JSON-serialized on the wire. Anything that does not survive this
// round-trip does not survive the channel (that is exactly how v2.2.1's
// { buffer } payload died while unit tests stayed green).
const channelSerialize = (msg) => JSON.parse(JSON.stringify(msg));

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips binary-exact, including 0x00 and 0xFF bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80, 0xfe, 0x00, 0x01]);
    const b64 = bytesToBase64(bytes);
    assert.equal(typeof b64, "string");
    const back = base64ToBytes(b64);
    assert.deepEqual(Array.from(back), Array.from(bytes));
  });

  it("round-trips a 5 MB random buffer (stack-safe chunked encode)", () => {
    const big = rand(5 * 1024 * 1024 + 7);
    const back = base64ToBytes(bytesToBase64(big));
    assert.equal(back.length, big.length);
    // spot-check rather than deep-compare 5M entries
    for (const k of [0, 1, big.length - 1, 1234567, 4_000_000]) {
      assert.equal(back[k], big[k], `byte ${k}`);
    }
  });

  it("handles boundary sizes: 0, 1, 2, 3 bytes", () => {
    for (const n of [0, 1, 2, 3]) {
      const bytes = rand(n);
      assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes))), Array.from(bytes));
    }
  });
});

describe("pdfTransportChunks", () => {
  it("single chunk below the chunk size", () => {
    const chunks = pdfTransportChunks(rand(1024));
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].length < 1024 * 1.4);
  });

  it("splits at the exact boundary and boundary ± 1", () => {
    for (const delta of [-1, 0, 1]) {
      const n = PDF_TRANSPORT_CHUNK_BYTES + delta;
      const chunks = pdfTransportChunks(rand(n));
      const expected = delta <= 0 ? (delta === 0 ? 1 : 1) : 2;
      assert.equal(chunks.length, expected, `n = chunkBytes ${delta}`);
    }
  });

  it("reassembles byte-exact from multiple chunks", () => {
    const bytes = rand(PDF_TRANSPORT_CHUNK_BYTES * 2 + 123);
    const chunks = pdfTransportChunks(bytes);
    assert.equal(chunks.length, 3);
    const parts = chunks.map(base64ToBytes);
    const out = new Uint8Array(bytes.length);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    assert.equal(at, bytes.length);
    for (let k = 0; k < bytes.length; k++) assert.equal(out[k], bytes[k]);
  });

  it("empty input yields zero chunks", () => {
    assert.deepEqual(pdfTransportChunks(new Uint8Array(0)), []);
  });
});

describe("pdf transport sessions (receiver side)", () => {
  it("accepts chunks out of order and assembles byte-exact", () => {
    const bytes = rand(PDF_TRANSPORT_CHUNK_BYTES + 500);
    const chunks = pdfTransportChunks(bytes);
    const session = makePdfTransportSession();
    const order = [1, 0]; // deliberately not 0, 1
    for (const k of order) {
      assert.ok(pdfSessionAddChunk(session, { index: k, b64: chunks[k] }));
    }
    const assembled = pdfSessionAssemble(session, bytes.length, chunks.length);
    assert.ok(assembled instanceof Uint8Array);
    assert.equal(assembled.length, bytes.length);
    for (const k of [0, 100, bytes.length - 1]) assert.equal(assembled[k], bytes[k]);
  });

  it("rejects duplicate chunks", () => {
    const session = makePdfTransportSession();
    assert.ok(pdfSessionAddChunk(session, { index: 0, b64: "QUJD" }));
    assert.equal(pdfSessionAddChunk(session, { index: 0, b64: "QUJD" }), false);
    assert.equal(session.received, 1);
  });

  it("rejects malformed chunk payloads", () => {
    const session = makePdfTransportSession();
    assert.equal(pdfSessionAddChunk(session, null), false);
    assert.equal(pdfSessionAddChunk(session, { index: -1, b64: "QQ==" }), false);
    assert.equal(pdfSessionAddChunk(session, { index: 0.5, b64: "QQ==" }), false);
    assert.equal(pdfSessionAddChunk(session, { index: 0 }), false);
    assert.equal(pdfSessionAddChunk(session, { index: 0, b64: "" }), false);
    assert.equal(pdfSessionAddChunk(session, { index: 0, b64: 42 }), false);
  });

  it("assemble fails closed on missing chunks, count mismatch, or byte mismatch", () => {
    const bytes = rand(3000);
    const chunks = pdfTransportChunks(bytes); // single chunk (under 2 MiB)
    const partial = makePdfTransportSession();
    pdfSessionAddChunk(partial, { index: 0, b64: chunks[0] });
    assert.equal(pdfSessionAssemble(partial, bytes.length, 2), null); // missing index 1
    assert.equal(pdfSessionAssemble(partial, bytes.length + 1, 1), null); // wrong total
    assert.equal(pdfSessionAssemble(partial, bytes.length - 1, 1), null); // wrong total
    assert.equal(pdfSessionAssemble(null, 1, 1), null);
  });

  it("isValidPdfTransportBegin validates shape and chunkCount bounds", () => {
    const C = PDF_TRANSPORT_CHUNK_BYTES;
    assert.ok(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: C + 1, chunkCount: 2 }));
    assert.ok(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: C, chunkCount: 1 }));
    assert.ok(isValidPdfTransportBegin({ name: "", totalBytes: 1, chunkCount: 1 }));
    assert.equal(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: C - 1, chunkCount: 2 }), false); // too many chunks
    assert.equal(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: C + 1, chunkCount: 1 }), false); // too few chunks
    assert.equal(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: 0, chunkCount: 1 }), false);
    assert.equal(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: -5, chunkCount: 1 }), false);
    assert.equal(isValidPdfTransportBegin({ name: "a.pdf", totalBytes: 10.5, chunkCount: 1 }), false);
    assert.equal(isValidPdfTransportBegin({ name: 42, totalBytes: 10, chunkCount: 1 }), false);
    assert.equal(isValidPdfTransportBegin({ totalBytes: 10, chunkCount: 1 }), false);
    assert.equal(isValidPdfTransportBegin(null), false);
    assert.equal(isValidPdfTransportBegin(undefined), false);
  });
});

describe("pdf transport over REAL channel semantics (issue #20)", () => {
  it("documents why ArrayBuffer transport died: it does not survive message serialization", () => {
    const legacy = channelSerialize({ payload: { buffer: new ArrayBuffer(8), name: "x.pdf" } });
    // This IS the v2.2.1 failure: the check in background.js
    // (buffer instanceof ArrayBuffer) is false after the hop.
    assert.equal(legacy.payload.buffer instanceof ArrayBuffer, false);
    assert.equal(legacy.payload.buffer.byteLength, undefined);
  });

  it("delivers a PDF byte-exact through a JSON-serializing channel", async () => {
    const bytes = rand(PDF_TRANSPORT_CHUNK_BYTES + 4242); // forces 2 chunks
    const file = { name: "roundtrip.pdf", size: bytes.length, arrayBuffer: async () => bytes.buffer };

    // Receiver side, mirroring the background router exactly (sessions,
    // chunk validation, assembly) — every message JSON-serialized on the way.
    // The final response carries only {ok, item, pages}: NO bytes cross the
    // channel back (responses serialize the same way messages do), so the
    // assembled buffer is verified receiver-side, like the real background
    // verifies before queueing.
    const sessions = new Map();
    let seq = 0;
    let assembledOut = null;
    const router = async (message) => {
      const msg = channelSerialize(message); // ← real channel semantics
      const { type, payload } = msg;
      if (type === "pdfImportBegin") {
        if (!isValidPdfTransportBegin(payload)) return { ok: false, error: "Invalid PDF import request." };
        const id = `sess-${++seq}`;
        const s = makePdfTransportSession();
        s.expectedTotal = payload.totalBytes;
        s.expectedCount = payload.chunkCount;
        sessions.set(id, s);
        return { ok: true, sessionId: id };
      }
      if (type === "pdfImportChunk") {
        const s = sessions.get(payload.sessionId);
        if (!s) return { ok: false, error: "Import session expired — pick the file again." };
        if (!pdfSessionAddChunk(s, payload)) return { ok: false, error: "Invalid PDF chunk." };
        return { ok: true, received: s.received };
      }
      if (type === "pdfImportEnd") {
        const s = sessions.get(payload.sessionId);
        if (!s) return { ok: false, error: "Import session expired — pick the file again." };
        const assembled = pdfSessionAssemble(s, s.expectedTotal, s.expectedCount);
        if (!assembled) return { ok: false, error: "PDF data incomplete — pick the file again." };
        assembledOut = assembled;
        return { ok: true, item: { id: "q1", title: "roundtrip.pdf" }, pages: 2 };
      }
      return { ok: false, error: "Unknown message type" };
    };

    // Responses cross the channel back — serialize them too.
    const send = async (message) => channelSerialize(await router(message));

    const result = await sendPdfImportViaChannel(file, send);
    assert.ok(result.ok, JSON.stringify(result).slice(0, 200));
    assert.equal(result.item.title, "roundtrip.pdf");
    assert.equal(result.pages, 2);
    // Receiver-side byte-exactness:
    assert.ok(assembledOut instanceof Uint8Array);
    assert.equal(assembledOut.length, bytes.length);
    for (const k of [0, 1, bytes.length - 1, 12345]) assert.equal(assembledOut[k], bytes[k]);
  });

  it("fails honestly when the channel drops mid-transfer (no fake success)", async () => {
    const bytes = rand(5000);
    const file = { name: "x.pdf", size: bytes.length, arrayBuffer: async () => bytes.buffer };
    const send = async (message) => {
      if (message.type === "pdfImportChunk") return null; // channel died
      return { ok: true, sessionId: "s1" };
    };
    const result = await sendPdfImportViaChannel(file, send);
    assert.equal(result.ok, false);
    assert.match(result.error, /interrupted|failed/i);
  });

  it("fails honestly on an unreadable file", async () => {
    const file = { name: "x.pdf", arrayBuffer: async () => { throw new Error("read error"); } };
    const result = await sendPdfImportViaChannel(file, async () => ({ ok: true, sessionId: "s" }));
    assert.equal(result.ok, false);
    assert.match(result.error, /Could not read/i);
  });
});
