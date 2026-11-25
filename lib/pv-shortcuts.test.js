/**
 * lib/pv-shortcuts.test.js — colocated tests for the keyboard-shortcuts /
 * read-from-here pure logic (issue #6).
 *
 * Run: `npm test` (node --test). Per TESTING.md: pure logic only, real
 * assertions, boundary values (0, 1, max, empty, null), no DOM/network.
 *
 * Expected chunk indices are DERIVED by executing buildTextChunks (G3
 * lesson: hand-counted offsets produce off-by-one failures), then asserted
 * to be self-consistent — the chunk returned must cover the anchor's
 * sentence, for every engine's chunking.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeForMatch,
  engineChunkLen,
  sentenceChunksFromSentences,
  sentenceIndexByPrefix,
  chunkIndexForSentence,
  readStartChunkFromParts,
} = require("./pv-shortcuts.js");
const { splitIntoSentences, buildTextChunks } = require("./pv-utils.js");

// Deterministic article: 60 sentences of varying length, five "paragraphs".
// Every sentence is UNIQUE (repeated identical tails would make anchor
// matching ambiguous by construction).
function makeArticle() {
  const paragraphs = [];
  for (let p = 0; p < 5; p++) {
    const sentences = [];
    for (let s = 0; s < 6; s++) {
      sentences.push(`Paragraph ${p} sentence ${s} says lorem ipsum dolor. ` +
        `Tail ${p}-${s} of consectetur adipiscing elit sed do eiusmod tempor.`);
    }
    paragraphs.push(sentences.join(" "));
  }
  return paragraphs.join("\n\n");
}

const ARTICLE = makeArticle();
const SENTENCES = splitIntoSentences(ARTICLE);

// ─── normalizeForMatch ────────────────────────────────────────────────────────

describe("normalizeForMatch", () => {
  it("collapses whitespace runs to single spaces", () => {
    assert.equal(normalizeForMatch("a\tb\n\nc   d"), "a b c d");
  });

  it("trims both ends", () => {
    assert.equal(normalizeForMatch("  hello world  "), "hello world");
  });

  it("returns empty string for non-strings and empty input", () => {
    assert.equal(normalizeForMatch(null), "");
    assert.equal(normalizeForMatch(undefined), "");
    assert.equal(normalizeForMatch(42), "");
    assert.equal(normalizeForMatch(""), "");
    assert.equal(normalizeForMatch("   \n\t "), "");
  });
});

// ─── engineChunkLen ───────────────────────────────────────────────────────────

describe("engineChunkLen", () => {
  it("maps every chunked engine to its playback size", () => {
    assert.equal(engineChunkLen("edge"), 900);
    assert.equal(engineChunkLen("openai"), 4000);
    assert.equal(engineChunkLen("elevenlabs"), 2500);
    assert.equal(engineChunkLen("kokoro"), 2500);
  });

  it("returns null for sentence-indexed and unknown engines", () => {
    assert.equal(engineChunkLen("local"), null);
    assert.equal(engineChunkLen("browser"), null);
    assert.equal(engineChunkLen(""), null);
    assert.equal(engineChunkLen(undefined), null);
    assert.equal(engineChunkLen("EDGE"), null); // case-sensitive by design
  });

  it("matches the chunking actually used per engine (drift guard)", () => {
    // Same article, per-engine chunk counts must differ (sizes differ),
    // and every engine's chunks must carry full sentence provenance.
    const engines = ["edge", "openai", "elevenlabs", "kokoro"];
    const counts = new Set();
    for (const engine of engines) {
      const chunks = buildTextChunks(ARTICLE, engineChunkLen(engine));
      counts.add(chunks.length);
      let covered = 0;
      for (const c of chunks) covered += c.sentenceCount;
      assert.equal(covered, SENTENCES.length,
        `${engine}: chunk provenance must cover every sentence exactly once`);
    }
    assert.ok(counts.size > 1, "engines chunk at different sizes");
  });
});

// ─── sentenceChunksFromSentences ──────────────────────────────────────────────

describe("sentenceChunksFromSentences", () => {
  it("maps sentence i to chunk {text, sentenceStart:i, sentenceCount:1}", () => {
    const chunks = sentenceChunksFromSentences(SENTENCES);
    assert.equal(chunks.length, SENTENCES.length);
    for (let i = 0; i < chunks.length; i++) {
      assert.deepEqual(
        { text: chunks[i].text, sentenceStart: chunks[i].sentenceStart, sentenceCount: chunks[i].sentenceCount },
        { text: SENTENCES[i], sentenceStart: i, sentenceCount: 1 }
      );
    }
  });

  it("handles empty and non-array input", () => {
    assert.deepEqual(sentenceChunksFromSentences([]), []);
    assert.deepEqual(sentenceChunksFromSentences(null), []);
    assert.deepEqual(sentenceChunksFromSentences(undefined), []);
  });
});

// ─── sentenceIndexByPrefix ────────────────────────────────────────────────────

describe("sentenceIndexByPrefix", () => {
  it("finds the sentence an anchor starts at", () => {
    const i = 7;
    assert.equal(sentenceIndexByPrefix(SENTENCES, SENTENCES[i]), i);
  });

  it("finds the sentence containing a mid-sentence anchor (selection start)", () => {
    // The slice must retain a unique fragment: an anchor that falls
    // entirely inside a repeated phrase ("of consectetur…") is ambiguous
    // by data, and by spec resolves to the EARLIEST match — re-reading
    // beats skipping ahead past the anchor.
    const i = 10; // "Paragraph 1 sentence 4 says lorem ipsum dolor."
    const mid = SENTENCES[i].slice(10, 60);
    assert.ok(mid.length >= 4 && !mid.startsWith(SENTENCES[i].slice(0, 10)));
    assert.equal(sentenceIndexByPrefix(SENTENCES, mid), i);
  });

  it("anchors on a repeated phrase resolve to the earliest match (never skip ahead)", () => {
    const repeated = "of consectetur adipiscing elit sed do eiusmod tempor."; // in every tail
    assert.equal(sentenceIndexByPrefix(SENTENCES, repeated), 1); // first tail sentence
  });

  it("matches an anchor whose whitespace differs (innerText vs joined text)", () => {
    const i = 5;
    const anchor = SENTENCES[i].replace(/ /g, "\n\t ");
    assert.equal(sentenceIndexByPrefix(SENTENCES, anchor), i);
  });

  it("matches an anchor spanning several sentences (long selection)", () => {
    const spanning = `${SENTENCES[4]} ${SENTENCES[5]}`;
    assert.equal(sentenceIndexByPrefix(SENTENCES, spanning), 4);
  });

  it("caps the probe at 64 chars — differences beyond that are ignored", () => {
    const i = 3;
    const anchor = SENTENCES[i].slice(0, 64) + " COMPLETELY DIFFERENT TAIL";
    assert.equal(sentenceIndexByPrefix(SENTENCES, anchor), i);
  });

  it("returns -1 for a prefix shorter than 4 chars", () => {
    assert.equal(sentenceIndexByPrefix(SENTENCES, "abc"), -1);
    assert.equal(sentenceIndexByPrefix(SENTENCES, ""), -1);
    assert.equal(sentenceIndexByPrefix(SENTENCES, null), -1);
  });

  it("returns -1 when nothing matches", () => {
    assert.equal(sentenceIndexByPrefix(SENTENCES, "zzz no such words here at all"), -1);
  });

  it("is case-sensitive — a case mismatch misses rather than jumps wrong", () => {
    const i = 2;
    assert.equal(sentenceIndexByPrefix(SENTENCES, SENTENCES[i].toUpperCase()), -1);
  });

  it("handles empty and non-array sentence lists", () => {
    assert.equal(sentenceIndexByPrefix([], "some anchor text"), -1);
    assert.equal(sentenceIndexByPrefix(null, "some anchor text"), -1);
    assert.equal(sentenceIndexByPrefix(undefined, "some anchor text"), -1);
  });

  it("boundary: first and last sentence anchors", () => {
    assert.equal(sentenceIndexByPrefix(SENTENCES, SENTENCES[0]), 0);
    const last = SENTENCES.length - 1;
    assert.equal(sentenceIndexByPrefix(SENTENCES, SENTENCES[last]), last);
  });
});

// ─── chunkIndexForSentence ────────────────────────────────────────────────────

describe("chunkIndexForSentence", () => {
  const chunks = buildTextChunks(ARTICLE, 900);

  it("returns the chunk whose provenance covers the sentence", () => {
    for (let si = 0; si < SENTENCES.length; si++) {
      const ci = chunkIndexForSentence(chunks, si);
      assert.ok(ci >= 0 && ci < chunks.length, `sentence ${si} must map to a chunk`);
      const c = chunks[ci];
      assert.ok(si >= c.sentenceStart && si < c.sentenceStart + c.sentenceCount,
        `chunk ${ci} provenance must cover sentence ${si}`);
    }
  });

  it("boundary: first sentence → chunk 0, last sentence → last chunk", () => {
    assert.equal(chunkIndexForSentence(chunks, 0), 0);
    assert.equal(chunkIndexForSentence(chunks, SENTENCES.length - 1), chunks.length - 1);
  });

  it("returns -1 out of range and for malformed input", () => {
    assert.equal(chunkIndexForSentence(chunks, -1), -1);
    assert.equal(chunkIndexForSentence(chunks, SENTENCES.length + 50), -1);
    assert.equal(chunkIndexForSentence([], 0), -1);
    assert.equal(chunkIndexForSentence(null, 0), -1);
    assert.equal(chunkIndexForSentence(chunks, "0"), -1);
    assert.equal(chunkIndexForSentence(chunks, undefined), -1);
  });

  it("defaults missing provenance fields (count → 1, start → 0)", () => {
    // Malformed chunks without provenance are treated as covering exactly
    // sentence 0 each — robustness, not positional indexing.
    assert.equal(chunkIndexForSentence([{ text: "a" }, { text: "b" }], 0), 0);
    assert.equal(chunkIndexForSentence([{ text: "a" }, { text: "b" }], 1), -1);
  });

  it("hard-split sentences: every chunk sharing a sentenceStart maps back", () => {
    // Force hard splits: a sentence longer than maxLen is cut into several
    // chunks that all carry the same sentenceStart.
    const long = "word ".repeat(400).trim() + "."; // > 900 chars
    const hard = buildTextChunks(long + " Short end.", 900);
    const splitStarts = hard.filter((c) => c.sentenceCount === 1).map((c) => c.sentenceStart);
    assert.ok(hard.length > 1, "long sentence must be hard-split");
    for (const si of splitStarts) {
      const ci = chunkIndexForSentence(hard, si);
      assert.equal(hard[ci].sentenceStart, si);
    }
  });
});

// ─── readStartChunkFromParts (composition, fails safe) ────────────────────────

describe("readStartChunkFromParts", () => {
  it("returns 0 for an unknown anchor (read from the top, never jump wrong)", () => {
    const chunks = buildTextChunks(ARTICLE, 900);
    assert.equal(readStartChunkFromParts(SENTENCES, chunks, "zzz not in the article"), 0);
    assert.equal(readStartChunkFromParts(SENTENCES, chunks, "abc"), 0);
    assert.equal(readStartChunkFromParts(SENTENCES, chunks, null), 0);
  });

  it("returns 0 for empty chunk lists", () => {
    assert.equal(readStartChunkFromParts(SENTENCES, [], SENTENCES[3]), 0);
    assert.equal(readStartChunkFromParts(SENTENCES, null, SENTENCES[3]), 0);
  });

  it("anchor at the first sentence → chunk 0", () => {
    assert.equal(readStartChunkFromParts(SENTENCES, buildTextChunks(ARTICLE, 900), SENTENCES[0]), 0);
  });

  it("engine integration: the returned chunk covers the anchor's sentence, per engine", () => {
    // Mirrors content.js composition: chunks are built with the ACTIVE
    // engine's chunk length (or sentence-indexed for local TTS).
    for (const engine of ["edge", "openai", "elevenlabs", "kokoro", "local"]) {
      const len = engineChunkLen(engine);
      const chunks = len
        ? buildTextChunks(ARTICLE, len)
        : sentenceChunksFromSentences(SENTENCES);

      for (const si of [0, 4, 9, 17, SENTENCES.length - 1]) {
        const start = readStartChunkFromParts(SENTENCES, chunks, SENTENCES[si]);
        assert.ok(start >= 0 && start < chunks.length, `${engine} s${si}: in range`);
        const c = chunks[start];
        assert.ok(si >= c.sentenceStart && si < c.sentenceStart + c.sentenceCount,
          `${engine} s${si}: chunk ${start} (${c.sentenceStart}+${c.sentenceCount}) must cover sentence`);
      }

      if (!len) {
        // Local TTS: chunk index IS the sentence index.
        const start = readStartChunkFromParts(SENTENCES, chunks, SENTENCES[9]);
        assert.equal(start, 9);
      }
    }
  });

  it("read-from-here differs from the top by design: a late anchor skips chunks", () => {
    const chunks = buildTextChunks(ARTICLE, 900);
    const late = readStartChunkFromParts(SENTENCES, chunks, SENTENCES[20]);
    assert.ok(late > 0, "an anchor at sentence 20 cannot start at chunk 0");
  });
});
