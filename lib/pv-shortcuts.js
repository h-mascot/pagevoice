/**
 * lib/pv-shortcuts.js — PageVoice keyboard-shortcuts / read-from-here pure
 * logic (issue #6).
 *
 * "Read from here" maps a DOM anchor (the user's selection or the paragraph
 * they right-clicked) onto the SAME chunk stream the active TTS engine will
 * actually play. Each engine chunks the article at its own size:
 *
 *   edge 900 · openai 4000 · elevenlabs 2500 · kokoro 2500
 *   local/browser TTS plays one sentence per utterance (sentence-indexed)
 *
 * so a start chunk computed for one engine's chunking would land in the
 * wrong place on another. engineChunkLen() is the single source of those
 * sizes — offscreen.js calls it for playback, content.js calls it to compute
 * the read-from-here start chunk, and a vm smoke asserts both agree.
 *
 * Kept pure so it can be unit-tested with `node --test` (colocated
 * pv-shortcuts.test.js) per TESTING.md; DOM wiring (selection/right-click
 * anchor, contextmenu recording) stays in content.js.
 *
 * Loading (no build step, MV3-safe): offscreen.html loads this after
 * lib/pv-utils.js and before offscreen.js; manifest content_scripts load it
 * before content.js; top-level declarations are globals in each context.
 * The Node export block at the bottom is inert in the browser.
 */

// ─── Whitespace normalisation ────────────────────────────────────────────────

// Collapse every whitespace run to a single space and trim the ends. The
// comparison form for anchor matching: innerText, textContent and the
// extracted article text differ mainly in whitespace.
function normalizeForMatch(text) {
  return (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
}

// ─── Engine chunk sizes ──────────────────────────────────────────────────────

// The chunk length each engine builds (see offscreen.js speak* functions).
// Returns null for sentence-indexed engines (local browser TTS and anything
// unknown) — callers then use sentenceChunksFromSentences() instead.
function engineChunkLen(engine) {
  switch (engine) {
    case "edge":       return 900;
    case "openai":     return 4000;
    case "elevenlabs": return 2500;
    case "kokoro":     return 2500;
    default:           return null;
  }
}

// Sentence-indexed "chunks" for the local TTS engine: speakWithLocalTTS
// plays one utterance per sentence, so chunk N IS sentence N.
function sentenceChunksFromSentences(sentences) {
  if (!Array.isArray(sentences)) return [];
  return sentences.map((text, i) => ({ text, sentenceStart: i, sentenceCount: 1 }));
}

// ─── Anchor → sentence ───────────────────────────────────────────────────────

// Find the sentence the anchor prefix points at: the FIRST sentence whose
// normalized text contains the probe (anchor at the sentence start or
// inside it — a selection that starts mid-sentence starts reading at that
// sentence), or, failing that, the first sentence that is a prefix of the
// anchor (an anchor whose prefix spans several sentences, e.g. a long
// selection).
//
// Guards: an anchor shorter than 4 chars is too weak to match (-1). The
// probe is capped at 64 chars — enough to be unique, short enough that
// probe-vs-sentence length differences stop mattering. Matching is
// case-sensitive on purpose: the anchor and the article text come from the
// same DOM, so a case mismatch means the wrong sentence — better to miss
// (callers fall back to reading from the top) than to jump somewhere wrong.
function sentenceIndexByPrefix(sentences, prefix) {
  const anchor = normalizeForMatch(prefix);
  if (!anchor || anchor.length < 4) return -1;
  const probe = anchor.slice(0, 64);

  if (Array.isArray(sentences)) {
    for (let i = 0; i < sentences.length; i++) {
      const s = normalizeForMatch(sentences[i]);
      if (s && s.includes(probe)) return i;
    }
    // Fallback pass (only when nothing contained the probe): the anchor
    // begins with a whole sentence and continues past its end.
    for (let i = 0; i < sentences.length; i++) {
      const s = normalizeForMatch(sentences[i]);
      if (s && s.length >= 8 && anchor.startsWith(s)) return i;
    }
  }
  return -1;
}

// ─── Sentence → chunk ────────────────────────────────────────────────────────

// The chunk whose sentence provenance [sentenceStart, sentenceStart +
// sentenceCount) covers the sentence index — the buildTextChunks provenance
// (issue #4) makes this exact, including hard-split long sentences where
// several chunks share one sentenceStart. Returns -1 when no chunk covers
// the index (out of range / malformed chunks).
function chunkIndexForSentence(chunks, sentenceIndex) {
  if (!Array.isArray(chunks) || typeof sentenceIndex !== "number") return -1;
  if (sentenceIndex < 0) return -1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] || {};
    const start = typeof c.sentenceStart === "number" ? c.sentenceStart : 0;
    const count = typeof c.sentenceCount === "number" ? c.sentenceCount : 1;
    if (sentenceIndex >= start && sentenceIndex < start + count) return i;
  }
  return -1;
}

// ─── Composition ─────────────────────────────────────────────────────────────

// Read-from-here start chunk from prebuilt parts: sentences and the chunk
// list built with the ACTIVE engine's chunking (see engineChunkLen).
// Fails safe: unknown anchor or unmapped sentence → 0 (read from the top),
// never a jump to a wrong position.
function readStartChunkFromParts(sentences, chunks, prefix) {
  const si = sentenceIndexByPrefix(sentences, prefix);
  if (si < 0) return 0;
  if (!Array.isArray(chunks) || chunks.length === 0) return 0;
  const ci = chunkIndexForSentence(chunks, si);
  return ci < 0 ? 0 : ci;
}

// ─── Node test-runner export (inert in the browser) ─────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeForMatch,
    engineChunkLen,
    sentenceChunksFromSentences,
    sentenceIndexByPrefix,
    chunkIndexForSentence,
    readStartChunkFromParts,
  };
}
