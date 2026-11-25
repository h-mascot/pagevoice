/**
 * lib/pv-highlight.js — PageVoice word-highlighting pure logic (issue #4)
 *
 * Side-effect-free helpers behind karaoke-style highlighting:
 *   - whitespace normalisation + sentence offsets in the normalized stream
 *   - char-level alignment between the extracted text and the DOM walk text
 *     (the two differ in whitespace and occasionally in hidden content)
 *   - mapping a playback position (media-time fraction, word-boundary
 *     ordinal, or utterance charIndex) to { sentence, word }
 *
 * Kept pure so it can be unit-tested with `node --test` (colocated
 * pv-highlight.test.js) per TESTING.md; DOM wiring stays in content.js,
 * audio wiring in offscreen.js.
 *
 * Loading (no build step, MV3-safe): offscreen.html loads this after
 * lib/pv-utils.js and before offscreen.js; manifest content_scripts load it
 * before content.js; top-level declarations are globals in each context.
 * The Node export block at the bottom is inert in the browser.
 */

// ─── Whitespace normalisation ────────────────────────────────────────────────

// Collapse every whitespace run (spaces, newlines, tabs) to a single space
// and trim the ends. This is the canonical comparison form: innerText and
// textContent differ mainly in whitespace.
function normalizeWhitespace(text) {
  return (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
}

// ─── Sentence offsets in the normalized stream ───────────────────────────────

// For a sentence list (as produced by splitIntoSentences), the character
// offset of each sentence's FIRST character inside the normalized stream
// (sentences joined with single spaces). Returns sentences.length + 1
// entries; the last is the stream length, so sentence i covers
// [starts[i], starts[i + 1]) — its text plus the separator that follows
// it (except for the final sentence, which runs to the stream end).
function sentenceStartOffsets(sentences) {
  const arr = Array.isArray(sentences) ? sentences : [];
  const starts = [0]; // first character of sentence 0
  let pos = 0;        // first-character offset of the NEXT sentence
  for (let k = 0; k < arr.length; k++) {
    const norm = normalizeWhitespace(arr[k]);
    if (norm) pos += norm.length + 1; // past this sentence + its separator
    starts.push(pos); // first char of sentence k+1 (stream end for the last)
  }
  // The final entry is one past the trailing separator: collapse it to the
  // stream length (0 for an empty stream).
  if (arr.length > 0 && starts[arr.length] > 0) starts[arr.length] -= 1;
  return starts;
}

// Which sentence covers `offset` in the normalized stream? Clamped: before
// the start → 0; beyond the end → the last sentence. Empty stream → -1.
function sentenceIndexAtOffset(starts, offset) {
  if (!Array.isArray(starts) || starts.length < 2) return -1;
  const last = starts.length - 2;
  if (offset >= starts[last + 1]) return last;
  if (offset <= starts[0]) return 0;
  // Binary search: greatest i with starts[i] <= offset. Empty sentences
  // (zero-length spans) are skipped because their start equals the next
  // sentence's start.
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ─── Char-level stream alignment (source text ↔ DOM walk text) ───────────────

// Find the next position where the two streams resynchronize after a
// mismatch: searches a bounded window forward, skipping d characters in
// either stream until a shared k-gram reappears. Returns [i, j] or null.
function findResync(source, walk, i, j) {
  const K = 8;
  const WINDOW = 512;
  for (let d = 1; d < WINDOW; d++) {
    const j2 = j + d;
    if (j2 + K <= walk.length) {
      const probe = walk.slice(j2, j2 + K);
      const at = source.indexOf(probe, Math.max(0, i - K));
      if (at !== -1 && at <= i + WINDOW) return [at, j2];
    }
    const i2 = i + d;
    if (i2 + K <= source.length) {
      const probe = source.slice(i2, i2 + K);
      const at = walk.indexOf(probe, Math.max(0, j - K));
      if (at !== -1 && at <= j + WINDOW) return [i2, at];
    }
  }
  return null;
}

// Monotone greedy alignment of two whitespace-normalized streams:
// map[j] = index in `source` corresponding to walk[j], or -1 when walk[j]
// has no counterpart (inserted/hidden content). Mismatches resync via
// findResync; after a resync the match point is extended BACKWARD while
// the preceding characters still agree, so the first character of the
// realigned region (e.g. the "B" of "Beta") is mapped instead of being
// lost to the k-gram probe. Everything skipped is left as -1.
function alignCharStreams(source, walk) {
  const map = new Array(walk.length).fill(-1);
  let i = 0;
  let j = 0;
  while (j < walk.length) {
    if (i < source.length && source[i] === walk[j]) {
      map[j] = i;
      i += 1;
      j += 1;
      continue;
    }
    const sync = findResync(source, walk, i, j);
    if (!sync) break;
    let [i2, j2] = sync;
    // Extend backward over agreeing chars, but never re-map positions
    // before the current mismatch point j (those are already settled).
    while (j2 > j && i2 > 0 && source[i2 - 1] === walk[j2 - 1]) {
      i2 -= 1;
      j2 -= 1;
    }
    i = i2;
    j = j2;
  }
  return map;
}

// ─── Word counting / playback position → word ordinal ────────────────────────

function countWords(text) {
  const t = normalizeWhitespace(text);
  if (!t) return 0;
  return t.split(" ").length;
}

// 0-based ordinal of the word CONTAINING char position `charPos` in the
// normalized text. charPos on a separator resolves to the preceding word;
// clamped into [0, len-1]. Empty text → 0.
function wordOrdinalAtChar(text, charPos) {
  const t = normalizeWhitespace(text);
  if (!t) return 0;
  let pos = Math.max(0, Math.min(Math.floor(charPos || 0), t.length - 1));
  while (pos > 0 && t[pos] === " ") pos -= 1;
  let ordinal = 0;
  for (let k = 0; k <= pos; k++) {
    if (t[k] !== " " && (k === 0 || t[k - 1] === " ")) ordinal += 1;
  }
  return Math.max(0, ordinal - 1);
}

// Fraction (0..1) of the way through the normalized text → char offset.
// Clamped. Rate-independent by construction: the caller derives the
// fraction from the AUDIO ELEMENT's media position (currentTime / duration),
// which is unaffected by playbackRate.
function fractionToCharOffset(text, fraction) {
  const t = normalizeWhitespace(text);
  if (!t) return 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Math.round(f * t.length);
}

// Fraction (0..1) through the chunk text → 0-based word ordinal.
function wordOrdinalFromFraction(text, fraction) {
  const offset = fractionToCharOffset(text, fraction);
  return offset <= 0 ? 0 : wordOrdinalAtChar(text, offset - 1);
}

// wordEvents: [{ offset, duration, text }] sorted by offset, where offset is
// in 100-nanosecond ticks from the start of the chunk's audio. mediaTimeSec
// is the audio element's currentTime (media position — a word's media offset
// is reached at the same currentTime whether playback runs at 0.5x or 3x).
// Returns the 0-based ordinal of the last word event that has started.
function wordOrdinalAtMediaTime(wordEvents, mediaTimeSec) {
  if (!Array.isArray(wordEvents) || wordEvents.length === 0) return 0;
  const t = Math.max(0, Number(mediaTimeSec) || 0) * 1e7; // seconds → 100ns ticks
  let count = 0;
  for (let k = 0; k < wordEvents.length; k++) {
    const off = wordEvents[k] ? wordEvents[k].offset : NaN;
    if (Number.isFinite(off) && off <= t) count = k + 1;
    else break;
  }
  return Math.max(0, count - 1);
}

// Map a word ordinal (counted through the whole chunk text) to
// { sentence, word }: sentence is the 0-based index (within `sentences`) of
// the sentence containing that word, word its 0-based index inside the
// sentence. Ordinals beyond the total clamp to the last word of the last
// non-empty sentence. No sentences → null.
function wordOrdinalToSentenceWord(sentences, ordinal) {
  if (!Array.isArray(sentences) || sentences.length === 0) return null;
  let remaining = Math.max(0, Math.floor(Number(ordinal) || 0));
  for (let i = 0; i < sentences.length; i++) {
    const n = countWords(sentences[i]);
    if (n === 0) continue;
    if (remaining < n) return { sentence: i, word: remaining };
    remaining -= n;
  }
  for (let i = sentences.length - 1; i >= 0; i--) {
    const n = countWords(sentences[i]);
    if (n > 0) return { sentence: i, word: n - 1 };
  }
  return null;
}

// ─── Node test-runner export (inert in the browser) ─────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeWhitespace,
    sentenceStartOffsets,
    sentenceIndexAtOffset,
    findResync,
    alignCharStreams,
    countWords,
    wordOrdinalAtChar,
    fractionToCharOffset,
    wordOrdinalFromFraction,
    wordOrdinalAtMediaTime,
    wordOrdinalToSentenceWord,
  };
}
