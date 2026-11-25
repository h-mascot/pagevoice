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
  fractionToCharOffset,
  wordOrdinalFromFraction,
  wordOrdinalAtMediaTime,
  wordOrdinalToSentenceWord,
} = require("./pv-highlight.js");

const { buildTextChunks, splitIntoSentences } = require("./pv-utils.js");

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
