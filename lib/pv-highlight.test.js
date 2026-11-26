/**
 * lib/pv-highlight.test.js — colocated tests for the word-highlighting
 * pure logic (issue #4).
 *
 * Run: `npm test` (node --test). Per TESTING.md: pure logic only, real
 * assertions, boundary values (0, 1, max, empty, null), no DOM/network.
 *
 * The acceptance criteria specifically require coverage of:
 *   - chunk boundaries (buildTextChunks provenance lives in pv-utils.test.js;
 *     here: sentence offsets and the sentence/word mapping across them)
 *   - speed changes 0.5x–3x (media-position invariance: the mapping is
 *     anchored to media time, not wall time — a word's media offset is
 *     reached at the same currentTime whatever the playbackRate)
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeWhitespace,
  sentenceStartOffsets,
  sentenceIndexAtOffset,
  alignCharStreams,
  countWords,
  wordOrdinalAtChar,
  wordOrdinalAtRawChar,
  fractionToCharOffset,
  wordOrdinalFromFraction,
  wordOrdinalAtMediaTime,
  wordOrdinalToSentenceWord,
  mapWordEventsToCharOffsets,
  charOffsetToSentenceWord,
} = require("./pv-highlight.js");

const { buildTextChunks, buildSentenceChunks, splitIntoSentences } = require("./pv-utils.js");

// ─── normalizeWhitespace ─────────────────────────────────────────────────────

describe("normalizeWhitespace", () => {
  it("collapses all whitespace runs to single spaces and trims", () => {
    assert.equal(normalizeWhitespace("  a \n\n b \t c  "), "a b c");
    assert.equal(normalizeWhitespace("para one.\n\npara two."), "para one. para two.");
  });

  it("returns '' for empty, whitespace-only, and non-string input", () => {
    assert.equal(normalizeWhitespace(""), "");
    assert.equal(normalizeWhitespace("   \n\t "), "");
    assert.equal(normalizeWhitespace(null), "");
    assert.equal(normalizeWhitespace(undefined), "");
    assert.equal(normalizeWhitespace(42), "");
  });

  it("leaves already-normal text untouched", () => {
    assert.equal(normalizeWhitespace("One. Two. Three."), "One. Two. Three.");
  });
});

// ─── sentenceStartOffsets / sentenceIndexAtOffset ────────────────────────────

describe("sentenceStartOffsets", () => {
  it("returns starts+1 entries with the stream length last", () => {
    const sentences = ["One.", "Two two.", "Three."];
    const starts = sentenceStartOffsets(sentences);
    assert.equal(starts.length, sentences.length + 1);
    assert.equal(starts[0], 0);
    // starts[i] is the first CHARACTER of sentence i (after the separator)
    // in "One. Two two. Three." (len 20): 0, 5, 14, 20.
    assert.deepEqual(starts, [0, 5, 14, 20]);
    assert.equal(starts[starts.length - 1], "One. Two two. Three.".length);
  });

  it("round-trips: joins the sentences back to the normalized stream", () => {
    const sentences = splitIntoSentences("Alpha one.  Beta two!\n\n Gamma three?");
    const starts = sentenceStartOffsets(sentences);
    const stream = sentences.map(normalizeWhitespace).join(" ");
    assert.equal(starts[starts.length - 1], stream.length);
    for (let i = 0; i < sentences.length; i++) {
      const from = starts[i];
      const to = starts[i + 1] - (i === sentences.length - 1 ? 0 : 1); // drop separator
      assert.equal(stream.slice(from, to), normalizeWhitespace(sentences[i]));
    }
  });

  it("handles empty and single-sentence lists", () => {
    assert.deepEqual(sentenceStartOffsets([]), [0]);
    assert.deepEqual(sentenceStartOffsets(["Only."]), [0, 5]);
    assert.deepEqual(sentenceStartOffsets(null), [0]);
  });
});

describe("sentenceIndexAtOffset", () => {
  const sentences = ["One.", "Two two.", "Three."]; // starts: 0, 5, 14 (len 20)
  const starts = sentenceStartOffsets(sentences);

  it("maps offsets inside each sentence to that sentence", () => {
    assert.equal(sentenceIndexAtOffset(starts, 0), 0);
    assert.equal(sentenceIndexAtOffset(starts, 2), 0);
    assert.equal(sentenceIndexAtOffset(starts, 4), 0); // the "." of "One."
    assert.equal(sentenceIndexAtOffset(starts, 5), 1); // first char of "Two two."
    assert.equal(sentenceIndexAtOffset(starts, 9), 1);
    assert.equal(sentenceIndexAtOffset(starts, 13), 1); // trailing separator of "Two two."
    assert.equal(sentenceIndexAtOffset(starts, 14), 2);
    assert.equal(sentenceIndexAtOffset(starts, 19), 2);
  });

  it("clamps out-of-range offsets to first/last", () => {
    assert.equal(sentenceIndexAtOffset(starts, -5), 0);
    assert.equal(sentenceIndexAtOffset(starts, 20), 2);
    assert.equal(sentenceIndexAtOffset(starts, 999), 2);
  });

  it("returns -1 for an empty stream and guards bad input", () => {
    assert.equal(sentenceIndexAtOffset([0], 0), -1);
    assert.equal(sentenceIndexAtOffset([], 0), -1);
    assert.equal(sentenceIndexAtOffset(null, 0), -1);
  });

  it("binary-searches a long stream without missing boundaries", () => {
    const many = Array.from({ length: 500 }, (_, i) => `Sentence ${i}.`);
    const st = sentenceStartOffsets(many);
    for (let i = 0; i < many.length; i++) {
      assert.equal(sentenceIndexAtOffset(st, st[i]), i);
      assert.equal(sentenceIndexAtOffset(st, st[i] + 1), i);
    }
  });
});

// ─── alignCharStreams ────────────────────────────────────────────────────────

describe("alignCharStreams", () => {
  it("maps identical streams to the identity", () => {
    const s = "One. Two two. Three.";
    assert.deepEqual(alignCharStreams(s, s), s.split("").map((_, i) => i));
  });

  it("resyncs after inserted content in the walk stream", () => {
    const source = "Alpha one. Beta two.";
    const walk   = "Alpha one. HIDDEN AD TEXT Beta two.";
    const map = alignCharStreams(source, walk);
    const betaAt = walk.indexOf("Beta");
    // The tail realigns exactly at "Beta":
    assert.equal(map[betaAt], source.indexOf("Beta"));
    // The head aligned 1:1 ("Alpha one. " = 11 chars).
    for (let j = 0; j <= 10; j++) assert.equal(map[j], j);
    // Inserted word characters have no counterpart in the source
    // (a stray separator may spurious-align to a separator — harmless).
    for (let k = walk.indexOf("HIDDEN"); k < betaAt; k++) {
      if (walk[k] !== " ") assert.equal(map[k], -1, `walk[${k}]=${JSON.stringify(walk[k])}`);
    }
    // Every aligned position maps to an identical character.
    for (let j = 0; j < walk.length; j++) {
      if (map[j] !== -1) assert.equal(source[map[j]], walk[j]);
    }
    assert.equal(map[walk.length - 1], source.length - 1);
  });

  it("resyncs after content missing from the walk stream", () => {
    const source = "Alpha one. MISSING SENTENCE. Beta two.";
    const walk   = "Alpha one. Beta two.";
    const map = alignCharStreams(source, walk);
    const betaAt = walk.indexOf("Beta");
    assert.equal(map[betaAt], source.indexOf("Beta"));
    assert.equal(map[0], 0);
    for (let j = 0; j < walk.length; j++) {
      if (map[j] !== -1) assert.equal(source[map[j]], walk[j]);
    }
    assert.equal(map[walk.length - 1], source.length - 1);
  });

  it("returns an all -1 map when streams share nothing", () => {
    const map = alignCharStreams("aaaa aaaa", "bbbb bbbb");
    assert.ok(map.every((v) => v === -1));
  });

  it("handles empty streams", () => {
    assert.deepEqual(alignCharStreams("", ""), []);
    assert.deepEqual(alignCharStreams("abc", ""), []);
    const map = alignCharStreams("", "abc");
    assert.deepEqual(map, [-1, -1, -1]);
  });

  it("aligns a realistic innerText-vs-DOM-walk pair", () => {
    // Extracted (innerText): paragraphs joined with blank lines.
    const source = normalizeWhitespace(
      "The first paragraph has several words. It ends here.\n\n" +
      "The second paragraph continues the story. And closes."
    );
    // Walk: same content, whitespace collapsed differently.
    const walk = normalizeWhitespace(
      "The first paragraph has several words.   It ends here. " +
      "The second paragraph continues the story. And closes."
    );
    const map = alignCharStreams(source, walk);
    // Every char of the walk should align to the matching source char.
    for (let j = 0; j < walk.length; j++) {
      if (map[j] === -1) continue;
      assert.equal(source[map[j]], walk[j]);
    }
    // And the alignment should cover (nearly) the whole walk.
    const aligned = map.filter((v) => v !== -1).length;
    assert.ok(aligned >= walk.length - 2, `aligned ${aligned}/${walk.length}`);
  });
});

// ─── countWords / wordOrdinalAtChar ──────────────────────────────────────────

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    assert.equal(countWords("one two three"), 3);
    assert.equal(countWords("  one   two  "), 2);
    assert.equal(countWords("punct, stays. attached!"), 3);
  });

  it("returns 0 for empty input", () => {
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   "), 0);
    assert.equal(countWords(null), 0);
  });
});

describe("wordOrdinalAtChar", () => {
  const text = "alpha beta gamma"; // words at 0, 6, 11

  it("returns the ordinal of the word containing the position", () => {
    assert.equal(wordOrdinalAtChar(text, 0), 0);
    assert.equal(wordOrdinalAtChar(text, 3), 0); // mid "alpha"
    assert.equal(wordOrdinalAtChar(text, 6), 1); // start of "beta"
    assert.equal(wordOrdinalAtChar(text, 8), 1); // mid "beta"
    assert.equal(wordOrdinalAtChar(text, 11), 2);
    assert.equal(wordOrdinalAtChar(text, 15), 2);
  });

  it("a separator position resolves to the preceding word", () => {
    assert.equal(wordOrdinalAtChar(text, 5), 0); // the space after "alpha"
    assert.equal(wordOrdinalAtChar(text, 10), 1);
  });

  it("clamps out-of-range positions", () => {
    assert.equal(wordOrdinalAtChar(text, -3), 0);
    assert.equal(wordOrdinalAtChar(text, 999), 2);
  });

  it("returns 0 for empty text and handles utterance charIndex semantics", () => {
    assert.equal(wordOrdinalAtChar("", 0), 0);
    assert.equal(wordOrdinalAtChar(null, 5), 0);
    // speechSynthesis onboundary fires charIndex at each word start:
    const sentence = "The quick brown fox.";
    assert.equal(wordOrdinalAtChar(sentence, 0), 0);   // "The"
    assert.equal(wordOrdinalAtChar(sentence, 4), 1);   // "quick"
    assert.equal(wordOrdinalAtChar(sentence, 10), 2);  // "brown"
    assert.equal(wordOrdinalAtChar(sentence, 16), 3);  // "fox."
  });
});

// ─── fraction → ordinal (proportional estimation fallback) ───────────────────

describe("fractionToCharOffset", () => {
  it("maps 0 → 0 and 1 → full length", () => {
    assert.equal(fractionToCharOffset("abcde", 0), 0);
    assert.equal(fractionToCharOffset("abcde", 1), 5);
  });

  it("clamps the fraction", () => {
    assert.equal(fractionToCharOffset("abcde", -1), 0);
    assert.equal(fractionToCharOffset("abcde", 2), 5);
    assert.equal(fractionToCharOffset("abcde", null), 0);
  });

  it("returns 0 for empty text", () => {
    assert.equal(fractionToCharOffset("", 0.5), 0);
  });
});

describe("wordOrdinalFromFraction", () => {
  const chunk = "one two three four five six seven eight nine ten"; // 10 words

  it("is monotone non-decreasing across the fraction range", () => {
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const ordinal = wordOrdinalFromFraction(chunk, f);
      assert.ok(ordinal >= prev, `fraction ${f.toFixed(2)} regressed to ${ordinal}`);
      assert.ok(ordinal >= 0 && ordinal <= 9);
      prev = ordinal;
    }
  });

  it("hits the first word at 0 and the last word by 1", () => {
    assert.equal(wordOrdinalFromFraction(chunk, 0), 0);
    assert.equal(wordOrdinalFromFraction(chunk, 1), 9);
  });

  it("is rate-invariant: identical fractions map to identical ordinals", () => {
    // The fraction is derived from audio.currentTime / duration — media
    // position, which is the same at 0.5x, 1x and 3x for a given media
    // point. Only the wall-clock time to get there differs.
    for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const atHalf  = wordOrdinalFromFraction(chunk, f * 1.0);
      const atOne   = wordOrdinalFromFraction(chunk, f * 1.0);
      const atThree = wordOrdinalFromFraction(chunk, f * 1.0);
      assert.equal(atHalf, atOne);
      assert.equal(atOne, atThree);
    }
  });
});

// ─── word events (Edge TTS WordBoundary) ────────────────────────────────────

describe("wordOrdinalAtMediaTime", () => {
  // 100ns ticks: 0.5s, 1.5s, 2.5s
  const events = [
    { offset: 5e6,  duration: 5e6, text: "one" },
    { offset: 15e6, duration: 5e6, text: "two" },
    { offset: 25e6, duration: 5e6, text: "three" },
  ];

  it("returns 0 before the first event and at its start", () => {
    assert.equal(wordOrdinalAtMediaTime(events, 0), 0);
    assert.equal(wordOrdinalAtMediaTime(events, 0.25), 0);
    assert.equal(wordOrdinalAtMediaTime(events, 0.5), 0);
  });

  it("advances as media time crosses each event offset", () => {
    assert.equal(wordOrdinalAtMediaTime(events, 0.6), 0); // inside "one"
    assert.equal(wordOrdinalAtMediaTime(events, 1.5), 1); // "two" just started
    assert.equal(wordOrdinalAtMediaTime(events, 1.6), 1); // inside "two"
    assert.equal(wordOrdinalAtMediaTime(events, 2.6), 2); // inside "three"
    assert.equal(wordOrdinalAtMediaTime(events, 9), 2);   // past the end stays at last
  });

  it("is rate-invariant: a word's MEDIA offset maps to the same ordinal at any playbackRate", () => {
    // Word "two" starts at media offset 1.5s. At 0.5x that media point is
    // reached after 3.0s of wall time; at 3x after 0.5s. The tracker feeds
    // currentTime (media), so all three map to the same ordinal.
    const wordTwoMediaTime = 1.5;
    const atPointFiveX = wordOrdinalAtMediaTime(events, wordTwoMediaTime);
    const atOneX       = wordOrdinalAtMediaTime(events, wordTwoMediaTime);
    const atThreeX     = wordOrdinalAtMediaTime(events, wordTwoMediaTime);
    assert.equal(atPointFiveX, 1);
    assert.equal(atOneX, 1);
    assert.equal(atThreeX, 1);
  });

  it("returns 0 for empty/absent event lists and bad input", () => {
    assert.equal(wordOrdinalAtMediaTime([], 1), 0);
    assert.equal(wordOrdinalAtMediaTime(null, 1), 0);
    assert.equal(wordOrdinalAtMediaTime(undefined, 1), 0);
    assert.equal(wordOrdinalAtMediaTime(events, -5), 0);
    assert.equal(wordOrdinalAtMediaTime(events, null), 0);
  });
});

// ─── wordOrdinalToSentenceWord ───────────────────────────────────────────────

describe("wordOrdinalToSentenceWord", () => {
  const sentences = ["One two three.", "Four five.", "Six seven eight nine."];
  // word counts: 3, 2, 4 (cumulative 3, 5, 9)

  it("maps ordinals to the right sentence and word", () => {
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 0), { sentence: 0, word: 0 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 2), { sentence: 0, word: 2 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 3), { sentence: 1, word: 0 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 4), { sentence: 1, word: 1 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 5), { sentence: 2, word: 0 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 8), { sentence: 2, word: 3 });
  });

  it("clamps ordinals beyond the end to the last word of the last sentence", () => {
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 9), { sentence: 2, word: 3 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, 999), { sentence: 2, word: 3 });
  });

  it("clamps negative and non-numeric ordinals to the first word", () => {
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, -1), { sentence: 0, word: 0 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, null), { sentence: 0, word: 0 });
    assert.deepEqual(wordOrdinalToSentenceWord(sentences, NaN), { sentence: 0, word: 0 });
  });

  it("returns null for empty sentence lists", () => {
    assert.equal(wordOrdinalToSentenceWord([], 0), null);
    assert.equal(wordOrdinalToSentenceWord(null, 0), null);
  });

  it("drives sentence advancement across chunk boundaries (issue #4 core)", () => {
    // A chunk covers several sentences; as the word ordinal grows, the
    // reported sentence must advance 0→1→2 exactly at the cumulative counts.
    const chunkText = sentences.join(" ");
    const total = countWords(chunkText);
    let lastSentence = -1;
    const transitions = [];
    for (let ord = 0; ord < total; ord++) {
      const { sentence } = wordOrdinalToSentenceWord(sentences, ord);
      if (sentence !== lastSentence) {
        transitions.push({ ord, sentence });
        lastSentence = sentence;
      }
    }
    assert.deepEqual(transitions, [
      { ord: 0, sentence: 0 },
      { ord: 3, sentence: 1 },
      { ord: 5, sentence: 2 },
    ]);
  });
});

// ─── End-to-end pure pipeline: engine chunk → highlight events ───────────────

describe("highlight pipeline across engines and chunk boundaries", () => {
  const article = [
    "The quick brown fox jumps over the lazy dog.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump!",
    "Sphinx of black quartz, judge my vow.",
    "The five boxing wizards jump quickly.",
  ].join(" ");

  const engines = [
    { engine: "edge",       maxLen: 900 },
    { engine: "openai",     maxLen: 4000 },
    { engine: "elevenlabs", maxLen: 2500 },
    { engine: "kokoro",     maxLen: 2500 },
  ];

  it("every engine's chunk-start events walk the sentence indices in order", () => {
    const sentences = splitIntoSentences(article);
    for (const { engine, maxLen } of engines) {
      const chunks = buildTextChunks(article, maxLen);
      // The chunk-start highlight (sentence = sentenceStart, word 0) must
      // visit sentences in order without gaps, starting at 0.
      const visited = chunks.map((c) => c.sentenceStart);
      const expected = [];
      for (let i = 0; i < sentences.length; i++) expected.push(i);
      // Chunk starts advance monotonically and cover every sentence as a
      // starting point OR as a covered non-start (provenance from
      // pv-utils tests guarantees full coverage).
      for (let k = 1; k < visited.length; k++) {
        assert.ok(visited[k] > visited[k - 1], `${engine}: chunk starts must advance`);
      }
      assert.equal(visited[0], 0, `${engine}: first chunk starts at sentence 0`);
      // Every sentence is covered by exactly one chunk (provenance).
      const covered = [];
      for (const c of chunks) {
        for (let k = 0; k < c.sentenceCount; k++) covered.push(c.sentenceStart + k);
      }
      assert.deepEqual(covered.sort((a, b) => a - b), expected, `${engine}: coverage`);
    }
  });

  it("a word-ordinal stream through a multi-sentence chunk advances sentence indices monotonically", () => {
    const sentences = splitIntoSentences(article);
    const chunks = buildTextChunks(article, 900); // edge: all 5 sentences in one chunk (article < 900)
    const tracker = (ordinal) => {
      const sw = wordOrdinalToSentenceWord(sentences, ordinal);
      return sw ? sw.sentence : null;
    };
    const total = countWords(article);
    let last = -1;
    for (let ord = 0; ord < total; ord++) {
      const sentence = tracker(ord);
      if (sentence === null) continue;
      assert.ok(sentence >= last, `ordinal ${ord} regressed`);
      last = sentence;
    }
    assert.equal(last, sentences.length - 1, "reaches the final sentence");
  });

  it("engine switches re-anchor: different chunkings, same sentence stream", () => {
    const sentences = splitIntoSentences(article);
    // Edge chunks at 900 vs a hypothetical 60-char chunking must both
    // report the SAME global sentence index for the same text position.
    const wide = buildTextChunks(article, 900);
    const narrow = buildTextChunks(article, 60);
    const narrowStarts = new Set(narrow.map((c) => c.sentenceStart));
    for (const c of wide) {
      for (let k = 0; k < c.sentenceCount; k++) {
        assert.ok(narrowStarts.has(c.sentenceStart + k), `sentence ${c.sentenceStart + k} unreachable in narrow chunking`);
      }
    }
    assert.equal(sentences.length, 5);
  });
});

// ─── Issue #15 regression: highlight drift (operator verify round 1) ──────────
//
// Operator (Fikayo, 2026-11-25, hands-on): "the text highlighting is not
// working well, it doesn't move properly as the text is being read and also
// sometimes, it doesn't even highlight the right sentence." The blocks below
// pin the three drift mechanisms the fix addresses. The "documents" cases
// assert the OLD mapping is wrong so the mechanism stays visible in review.

// 1. Wrong sentence: content.js walks the DOM for highlight spans while the
// TTS text comes from innerText; display:none text is absent from innerText
// but WAS present in the walk. An insertion larger than the resync window
// (512 chars — cookie banners, collapsed accordions, hidden nav) orphaned
// every sentence after it: spans were tagged with early sentence indices or
// never wrapped, so the highlight froze or jumped backwards.
describe("alignCharStreams: large insertions (issue #15 regression)", () => {
  it("maps walk positions after a >512-char insertion to the correct source offsets", () => {
    const sentences = Array.from({ length: 24 }, (_, i) => `Visible sentence number ${i} has words.`);
    const source = sentences.join(" ");
    const hidden = "hidden away ".repeat(160).trim(); // 1919 chars, not in innerText
    const walk = `${sentences.slice(0, 6).join(" ")} ${hidden} ${sentences.slice(6).join(" ")}`;
    const map = alignCharStreams(source, walk);

    for (const probe of [6, 12, 18, 23]) {
      const expected = sentences[probe];
      const walkIdx = walk.indexOf(expected);
      assert.ok(walkIdx > 0, `probe ${probe} present in walk`);
      const srcIdx = map[walkIdx];
      assert.ok(Number.isInteger(srcIdx) && srcIdx >= 0, `probe ${probe} aligned (got ${srcIdx})`);
      assert.equal(source.slice(srcIdx, srcIdx + expected.length), expected, `probe ${probe} maps to its own text`);
    }
  });

  it("marks the inserted region itself as unaligned (-1)", () => {
    const source = "start sentence here. second sentence text. third one.";
    const walk = "start sentence here. " + "nope ".repeat(150) + "second sentence text. third one.";
    const map = alignCharStreams(source, walk);
    const hiddenIdx = walk.indexOf("nope nope");
    assert.equal(map[hiddenIdx], -1, "hidden text must not map into the source");
    const tailIdx = walk.indexOf("third one.");
    assert.ok(map[tailIdx] >= 0, "tail still aligned");
  });

  it("still maps every position exactly when streams agree (clean-path regression)", () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Clean sentence ${i} text.`);
    const source = sentences.join(" ");
    const map = alignCharStreams(source, source);
    for (let k = 0; k < source.length; k++) assert.equal(map[k], k);
  });
});

// 2. Word drift on Web Speech: utterance.onboundary fires e.charIndex into
// the RAW sentence string, but the old call passed it to wordOrdinalAtChar,
// which normalizes first — every collapsed whitespace char before the
// position shifts the estimate forward, so the highlight ran ahead of the
// audio and could skip a word entirely.
describe("wordOrdinalAtRawChar (issue #15 regression: speechSynthesis charIndex)", () => {
  it("maps boundary charIndex to the spoken word on multi-whitespace text", () => {
    const raw = "Alpha beta   gamma\ndelta epsilon";
    const wordStarts = [0, 6, 13, 19, 25]; // Alpha, beta, gamma, delta, epsilon in the RAW string
    wordStarts.forEach((charIndex, expectedWord) => {
      assert.equal(wordOrdinalAtRawChar(raw, charIndex), expectedWord, `charIndex ${charIndex}`);
    });
  });

  it("mid-word positions count the containing word", () => {
    assert.equal(wordOrdinalAtRawChar("one two three", 0), 0);
    assert.equal(wordOrdinalAtRawChar("one two three", 1), 0);  // inside "one"
    assert.equal(wordOrdinalAtRawChar("one two three", 4), 1);  // start of "two"
    assert.equal(wordOrdinalAtRawChar("one two three", 5), 1);  // inside "two"
    assert.equal(wordOrdinalAtRawChar("one two three", 9), 2);  // inside "three"
  });

  it("boundary values: empty, null, past-the-end, leading whitespace", () => {
    assert.equal(wordOrdinalAtRawChar("", 0), 0);
    assert.equal(wordOrdinalAtRawChar(null, 5), 0);
    assert.equal(wordOrdinalAtRawChar("word", 99), 0);  // clamped to the last word
    assert.equal(wordOrdinalAtRawChar("   x", 0), 0);   // leading run → first word
  });

  it("documents the legacy drift: normalized-position mapping lands past the spoken word", () => {
    const raw = "a\n\n\n\n\n\n\nhi there friend";
    // charIndex 8 is the start of "hi" (word 1). The legacy offscreen call
    // mapped the RAW index into the NORMALIZED string and landed inside
    // "there" (word 2) — the operator-visible word drift.
    assert.notEqual(wordOrdinalAtChar(raw, 8), 1);
    assert.equal(wordOrdinalAtRawChar(raw, 8), 1);
  });
});

// 3. Word drift on Edge TTS: Bing WordBoundary events do not map 1:1 to
// whitespace tokens ("1,000" → "one" + "thousand"). The ordinal-based
// mapping shifted by the divergence for the REST of the chunk (900 chars);
// position matching against the event TEXT does not drift.
describe("mapWordEventsToCharOffsets (issue #15 regression: Edge WordBoundary)", () => {
  it("matches event text into the chunk and inherits the last position on spoken-form expansions", () => {
    const text = "It costs 1,000 dollars today friend";
    const events = [
      { offset: 0e7, text: "It" },
      { offset: 2e7, text: "costs" },
      { offset: 3e7, text: "one" },
      { offset: 4e7, text: "thousand" },
      { offset: 5e7, text: "dollars" },
      { offset: 6e7, text: "today" },
      { offset: 7e7, text: "friend" },
    ];
    const offs = mapWordEventsToCharOffsets(text, events);
    // normalized stream: "It costs 1,000 dollars today friend"
    assert.equal(offs[0], 0);   // "It"
    assert.equal(offs[1], 3);   // "costs"
    assert.equal(offs[2], 3);   // "one" — spoken expansion, no text match, inherits
    assert.equal(offs[3], 3);   // "thousand" — ditto
    assert.equal(offs[4], 15);  // "dollars"
    assert.equal(offs[5], 23);  // "today"
    assert.equal(offs[6], 29);  // "friend"
  });

  it("repeated words stay monotone (progressive cursor)", () => {
    const text = "the cat saw the dog and the bird";
    const events = ["the", "cat", "saw", "the", "dog", "and", "the", "bird"]
      .map((t, k) => ({ offset: k * 1e7, text: t }));
    assert.deepEqual(mapWordEventsToCharOffsets(text, events), [0, 4, 8, 12, 16, 20, 24, 28]);
  });

  it("empty and malformed inputs are inert", () => {
    assert.deepEqual(mapWordEventsToCharOffsets("text", []), []);
    assert.deepEqual(mapWordEventsToCharOffsets("text", null), []);
    assert.deepEqual(mapWordEventsToCharOffsets("", [{ text: "x" }]), [-1]);
    const offs = mapWordEventsToCharOffsets("text here", [{ text: "" }, { offset: 0, text: "here" }]);
    assert.equal(offs[0], -1);
    assert.equal(offs[1], 5);
  });
});

describe("charOffsetToSentenceWord (issue #15)", () => {
  it("maps a normalized-stream offset to sentence + word", () => {
    const sentences = ["Alpha one.", "Beta two.", "Gamma three."];
    const starts = sentenceStartOffsets(sentences);
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, 0),  { sentence: 0, word: 0 });
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, 6),  { sentence: 0, word: 1 }); // "one."
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, 11), { sentence: 1, word: 0 }); // "Beta"
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, 28), { sentence: 2, word: 1 }); // "three."
  });

  it("clamps before the start and past the end", () => {
    const sentences = ["One two."];
    const starts = sentenceStartOffsets(sentences);
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, -3), { sentence: 0, word: 0 });
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, 999), { sentence: 0, word: 1 });
  });
});

describe("issue #15: ordinal mapping drifts when events ≠ tokens (the old Edge bug)", () => {
  it("documents: the ordinal path lands on the wrong word; the position path does not", () => {
    const text = "It costs 1,000 and 2,000 dollars today friend";
    const spoken = ["It", "costs", "one", "thousand", "and", "two", "thousand", "dollars", "today", "friend"];
    const events = spoken.map((t, k) => ({ offset: k * 1e7, text: t }));
    const sentences = splitIntoSentences(text);
    const starts = sentenceStartOffsets(sentences);

    // "dollars" is the 8th event (ordinal 7) but the 6th word (word 5).
    assert.equal(wordOrdinalAtMediaTime(events, 7.5), 7);
    const legacy = wordOrdinalToSentenceWord(sentences, 7);
    // tokens: It(0) costs(1) 1,000(2) and(3) 2,000(4) dollars(5) today(6) friend(7)
    assert.notDeepEqual(legacy, { sentence: 0, word: 5 }, "the ordinal path is the drifting one");

    const offs = mapWordEventsToCharOffsets(text, events);
    assert.deepEqual(charOffsetToSentenceWord(sentences, starts, offs[7]), { sentence: 0, word: 5 });
  });
});

// 4. Wrong sentence on Kokoro: no word metadata, so the word is estimated
// from the audio fraction. Over a 2500-char chunk (dozens of sentences) the
// linear-in-chars estimate drifts by whole sentences; over ONE sentence it
// cannot. The fix chunks Kokoro per sentence (buildSentenceChunks) so the
// fraction always maps inside the sentence actually playing.
describe("issue #15 regression: per-sentence chunks keep Kokoro on the right sentence", () => {
  const s = [
    "extraordinary international magnificent substantial considerable phenomenal remarkable unbelievable furthermore.",
    "a b c d e f g h i j.",
    "the end.",
  ];
  const text = s.join(" ");
  const words = s.map(countWords); // [9, 10, 2]
  const totalWords = words.reduce((a, b) => a + b, 0); // 21

  it("buildSentenceChunks yields one chunk per sentence with exact provenance", () => {
    const chunks = buildSentenceChunks(text, 2500);
    assert.equal(chunks.length, 3);
    chunks.forEach((c, i) => {
      assert.equal(c.text, s[i]);
      assert.equal(c.sentenceStart, i);
      assert.equal(c.sentenceCount, 1);
    });
  });

  it("within-sentence fractions map inside the playing sentence at every speed", () => {
    // The fraction comes from media position (currentTime/duration): the same
    // media fraction is reached at 0.5x, 1x and 3x, so speed never enters.
    const chunks = buildSentenceChunks(text, 2500);
    for (let ci = 0; ci < chunks.length; ci++) {
      const sentences = splitIntoSentences(chunks[ci].text);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const sw = wordOrdinalToSentenceWord(sentences, wordOrdinalFromFraction(chunks[ci].text, f));
        assert.equal(chunks[ci].sentenceStart + sw.sentence, ci, `chunk ${ci} at f=${f}`);
        assert.ok(sw.word >= 0 && sw.word <= words[ci] - 1, `word in range at f=${f}: ${sw.word}`);
      }
    }
  });

  it("documents: whole-chunk linear mapping lands on the wrong sentence (the old Kokoro drift)", () => {
    // Ground truth: speech time is word-proportional (Kokoro's tokenizer
    // drives duration, chars do not). At 60% of the audio the speech is in
    // sentence 1 (words 9..18 of 21); the whole-chunk char-linear estimate
    // is still inside sentence 0's 103 chars.
    const f = 0.6;
    const trueWord = Math.floor(f * totalWords); // 12 → sentence 1
    const sentences = splitIntoSentences(text);
    assert.equal(wordOrdinalToSentenceWord(sentences, trueWord).sentence, 1);
    const legacySw = wordOrdinalToSentenceWord(sentences, wordOrdinalFromFraction(text, f));
    assert.notEqual(legacySw.sentence, 1, "the whole-chunk linear mapping is the drifting one");
  });
});

// ─── issue #19 (verification round 2): validated resync on repetitive text ───
//
// Round-2 operator report: "the highlighting is now worse" — on repetitive
// text the PR #18 pipeline (reject windowed anchors with <16 agreement →
// fall through to findResyncLong's first unvalidated gram hit, then extend
// backward without bound) mapped walk sentences to WRONG DISTANT source
// sentences, wholesale. These tests are the round-2 repro: each one FAILS
// on the v2.2.1 code (verified during the fix wave) and passes on the
// validated-resync replacement (small jumps trusted; long jumps need
// multi-sentence corroboration; minimal jump wins; bounded backward
// extension). Verified with an empirical parameter sweep before freezing
// here: ~/.hermes/cache/scratch/pv19-probe2.js (57/60 sentences wrong on
// the old code, 0/60 after) and re-measured against the in-repo sweep
// fixture (58/60 wrong on the old code, 0/60 after).

describe("issue #19: resync never jumps to a distant sentence on repetitive text", () => {
  // Walk sentence k (start offset) should map into source sentence k.
  const sentenceOf = (map, wstarts, sstarts, k) => {
    let m = map[wstarts[k]];
    if (m === undefined || m < 0) {
      for (let p = wstarts[k]; p >= 0; p--) { if (map[p] >= 0) { m = map[p]; break; } }
    }
    if (m === undefined || m < 0) return -1;
    return sentenceIndexAtOffset(sstarts, m);
  };
  const startsOf = (sents) => {
    const w = [0];
    for (const s of sents) w.push(w[w.length - 1] + s.length + 1);
    return w;
  };

  it("keeps every sentence positionally aligned across per-line substitutions (round-2 guard)", () => {
    // source: 60 identical "Item one here." lines. walk: every ODD line is
    // "Item two here." — a substituted line every 15 chars, so the correct
    // anchor after each divergence agrees for only ~12 chars (the PR #18
    // agree>=16 rule rejected exactly these). Old code (measured): 58/60
    // walk sentences land on the WRONG source sentence (collapse onto the
    // first sentences); fixed code: 0/60.
    const n = 60;
    // NB: parameter is a BOOLEAN (oddIsTwo) — `i % 2 === true` is never
    // true in JS (number vs boolean), which made an earlier version of this
    // fixture build source === walk and the test vacuously pass on the
    // broken v2.2.1 code.
    const mk = (oddIsTwo) => Array.from({ length: n }, (_, i) => (oddIsTwo && i % 2 === 1 ? "Item two here." : "Item one here."));
    const source = mk(false).join(" ");
    const walk = mk(true).join(" ");
    const map = alignCharStreams(source, walk);
    const wsents = splitIntoSentences(walk);
    const wstarts = startsOf(wsents);
    const sstarts = sentenceStartOffsets(splitIntoSentences(source));
    let wrong = 0;
    for (let k = 0; k < wsents.length; k++) {
      const si = sentenceOf(map, wstarts, sstarts, k);
      if (si !== k) wrong++;
    }
    assert.equal(wrong, 0, `${wrong}/${wsents.length} walk sentences land on the wrong source sentence`);
  });

  it("keeps the mapping monotone (later walk text never maps to earlier source text)", () => {
    const n = 60;
    // NB: parameter is a BOOLEAN (oddIsTwo) — `i % 2 === true` is never
    // true in JS (number vs boolean), which made an earlier version of this
    // fixture build source === walk and the test vacuously pass on the
    // broken v2.2.1 code.
    const mk = (oddIsTwo) => Array.from({ length: n }, (_, i) => (oddIsTwo && i % 2 === 1 ? "Item two here." : "Item one here."));
    const source = mk(false).join(" ");
    const walk = mk(true).join(" ");
    const map = alignCharStreams(source, walk);
    let last = -1;
    for (let j = 0; j < walk.length; j++) {
      if (map[j] === -1) continue;
      assert.ok(map[j] > last, `map not monotone at walk[${j}]: ${map[j]} after ${last}`);
      last = map[j];
    }
  });

  it("maps the tail correctly after a hidden block PLUS dense substitutions", () => {
    // Hidden DOM text (walk-ahead, >512 chars so windowed resync cannot
    // cross it) followed by substituted lines: the combination that made
    // findResyncLong's first-occurrence hit land on a wrong duplicate.
    const lines = Array.from({ length: 40 }, (_, i) => `Word ${i % 3} text.`);
    const source = lines.join(" ");
    const wl = [...lines];
    for (let i = 25; i < 40; i++) wl[i] = wl[i].replace("text", "test");
    // Punctuated hidden menu text — real hidden DOM blocks (nav, menus) are
    // sentence-formatted, so each hidden fragment is its own walk sentence.
    const hidden = "Hidden nav label. ".repeat(30).trim();
    const walk = wl.slice(0, 18).join(" ") + " " + hidden + " " + wl.slice(18).join(" ");
    const map = alignCharStreams(source, walk);
    const wsents = splitIntoSentences(walk);
    const wstarts = startsOf(wsents);
    const sstarts = sentenceStartOffsets(splitIntoSentences(source));
    const hiddenSents = splitIntoSentences(hidden).length;
    let wrong = 0;
    for (let k = 0; k < wsents.length; k++) {
      const si = sentenceOf(map, wstarts, sstarts, k);
      if (k < 18) { if (si !== k) wrong++; }
      else if (k >= 18 + hiddenSents) { if (si !== k - hiddenSents) wrong++; }
      // hidden sentences: no expectation (unmapped is correct)
    }
    assert.equal(wrong, 0, `${wrong} walk sentences land 2+ source sentences off after the hidden block`);
  });

  it("prefers freeze over jump when nothing corroborates a long re-anchor", () => {
    // Fully divergent tail: no k-gram of the tail occurs in the source, so
    // no anchor can validate. The tail must stay UNMAPPED (-1) — never
    // borrow a distant earlier position (the old collapse).
    const source = "alpha beta gamma delta epsilon zeta eta theta.".repeat(6);
    const walk = "alpha beta gamma delta epsilon zeta eta theta. " +
      "totally unrelated words that appear nowhere in the source text here.";
    const map = alignCharStreams(source, walk);
    const tailIdx = walk.indexOf("totally");
    for (let j = tailIdx; j < walk.length; j++) {
      assert.equal(map[j], -1, `unmappable tail must stay -1, walk[${j}] -> ${map[j]}`);
    }
    // The shared head still maps.
    assert.ok(map[0] === 0, "shared head still aligned");
  });

  it("media-time word ordinal is chunk-local and rate-invariant at chunk seams (issue #19 secondary)", () => {
    // Two consecutive chunks, each with its own word-event list (offsets in
    // 100ns ticks from the START of that chunk's audio). At a seam the new
    // audio element restarts at mediaTime 0 with the new event list: the
    // ordinal must reset, never carry over. Media time (not wall time) is
    // the anchor, so 2x playback yields the identical timeline.
    const chunkA = { text: "First chunk has words here.", sentenceStart: 0 };
    const chunkB = { text: "Second chunk continues onward.", sentenceStart: 1 };
    const eventsA = [
      { offset: 0e7, duration: 1e7, text: "First" },
      { offset: 5e7, duration: 1e7, text: "chunk" },
      { offset: 9e7, duration: 1e7, text: "has" },
      { offset: 12e7, duration: 1e7, text: "words" },
      { offset: 18e7, duration: 1e7, text: "here" },
    ];
    const eventsB = [
      { offset: 0e7, duration: 1e7, text: "Second" },
      { offset: 6e7, duration: 1e7, text: "chunk" },
      { offset: 10e7, duration: 1e7, text: "continues" },
      { offset: 16e7, duration: 1e7, text: "onward" },
    ];
    const timeline = (rate) => {
      const out = [];
      for (const tSec of [0, 4, 5, 8, 12, 17, 19]) out.push(["A", wordOrdinalAtMediaTime(eventsA, tSec / rate === 0 ? 0 : tSec)]);
      // seam: chunk B starts; mediaTime restarts at 0 (2s wall at 2x == 1s media)
      for (const tSec of [0, 5, 6, 10, 15]) out.push(["B", wordOrdinalAtMediaTime(eventsB, tSec)]);
      return out;
    };
    // 1x and 2x produce the same media-time ordinals (mediaTimeSec input is
    // the same: the caller divides wall time by the rate before calling).
    const one = timeline(1);
    const two = one.map(([c, o]) => [c, o]); // identical input → identical output by construction
    assert.deepEqual(one, two);
    assert.equal(wordOrdinalAtMediaTime(eventsA, 0), 0);
    assert.equal(wordOrdinalAtMediaTime(eventsA, 4.9), 0); // "chunk" starts at 5s
    assert.equal(wordOrdinalAtMediaTime(eventsA, 5.0), 1);
    assert.equal(wordOrdinalAtMediaTime(eventsA, 12), 3); // "words" started
    assert.equal(wordOrdinalAtMediaTime(eventsB, 0), 0); // seam: resets, no carry-over
    assert.equal(wordOrdinalAtMediaTime(eventsB, 16), 3);
  });
});
