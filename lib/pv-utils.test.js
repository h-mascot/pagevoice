/**
 * lib/pv-utils.test.js — colocated tests for the pure logic in pv-utils.js
 *
 * Run: `npm test` (node --test). Per TESTING.md: pure logic only, real
 * assertions, boundary values (0, 1, max, empty, null), no DOM/network.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getStreamElementsVoice,
  escapeXml,
  clampAudioRate,
  clampKokoroSpeed,
  clampStartIndex,
  speedToProsodyRate,
  splitIntoSentences,
  splitText,
} = require("./pv-utils.js");

// ─── splitIntoSentences ───────────────────────────────────────────────────────

describe("splitIntoSentences", () => {
  it("returns [] for empty, whitespace, null, and undefined input", () => {
    assert.deepEqual(splitIntoSentences(""), []);
    assert.deepEqual(splitIntoSentences("   \n\t "), []);
    assert.deepEqual(splitIntoSentences(null), []);
    assert.deepEqual(splitIntoSentences(undefined), []);
  });

  it("splits on ., !, and ? keeping the terminator", () => {
    assert.deepEqual(splitIntoSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  });

  it("keeps a trailing fragment without punctuation", () => {
    assert.deepEqual(splitIntoSentences("One. Two"), ["One.", "Two"]);
  });

  it("keeps runs of terminators together", () => {
    assert.deepEqual(splitIntoSentences("Wow!! Really??"), ["Wow!!", "Really??"]);
  });

  it("returns the whole text as one sentence when unmarked", () => {
    assert.deepEqual(splitIntoSentences("hello world"), ["hello world"]);
  });

  it("trims each sentence", () => {
    assert.deepEqual(splitIntoSentences("  One.   Two.  "), ["One.", "Two."]);
  });
});

// ─── splitText ────────────────────────────────────────────────────────────────

describe("splitText", () => {
  it("returns [] for empty, whitespace, null, and undefined input", () => {
    assert.deepEqual(splitText("", 900), []);
    assert.deepEqual(splitText("   ", 900), []);
    assert.deepEqual(splitText(null, 900), []);
    assert.deepEqual(splitText(undefined, 900), []);
  });

  it("returns a single chunk when text fits maxLen", () => {
    assert.deepEqual(splitText("One. Two!", 100), ["One. Two!"]);
  });

  it("starts a new chunk when adding the next sentence would exceed maxLen", () => {
    // "A. B." is 5 chars; "A. B. C." would be 8 > 7 → split before "C."
    assert.deepEqual(splitText("A. B. C.", 7), ["A. B.", "C."]);
  });

  it("hard-splits a single sentence longer than maxLen into maxLen-sized parts", () => {
    const long = "word ".repeat(6).trim(); // "word word word word word word" (29 chars)
    const chunks = splitText(long, 10);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) assert.ok(c.length <= 10, `chunk too long: "${c}"`);
    assert.equal(chunks.join(" "), long); // no content lost
  });

  it("flushes the pending chunk before a hard split", () => {
    // First sentence short (queued), second very long (forces flush + hard split).
    const long2 = "x".repeat(25);
    const chunks = splitText(`Short. ${long2}`, 10);
    assert.equal(chunks[0], "Short.");
    assert.deepEqual(chunks.slice(1), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("preserves all content across sentence-aware chunking", () => {
    const text = "Alpha sentence here. Beta sentence there. Gamma.";
    const chunks = splitText(text, 30);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.length <= 30, `chunk too long: "${c}"`);
    assert.equal(chunks.join(" "), text);
  });

  it("returns a single short sentence unchanged", () => {
    assert.deepEqual(splitText("Ok.", 5), ["Ok."]);
  });
});

// ─── escapeXml ────────────────────────────────────────────────────────────────

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    assert.equal(escapeXml("It's <b>&\"q\"</b>"), "It&apos;s &lt;b&gt;&amp;&quot;q&quot;&lt;/b&gt;");
  });

  it("escapes & first so double-escaping does not occur", () => {
    assert.equal(escapeXml("&amp;"), "&amp;amp;");
  });

  it("returns input unchanged when no specials present", () => {
    assert.equal(escapeXml("plain text 123"), "plain text 123");
  });

  it("returns empty string for empty input", () => {
    assert.equal(escapeXml(""), "");
  });
});

// ─── clampAudioRate (0.25–4.0, default 1.0) ───────────────────────────────────

describe("clampAudioRate", () => {
  it("passes through rates inside the range", () => {
    assert.equal(clampAudioRate(1.0), 1.0);
    assert.equal(clampAudioRate(2.5), 2.5);
    assert.equal(clampAudioRate(0.25), 0.25);
    assert.equal(clampAudioRate(4.0), 4.0);
  });

  it("clamps out-of-range rates to the bounds", () => {
    assert.equal(clampAudioRate(10.0), 4.0);
    assert.equal(clampAudioRate(0.1), 0.25);
    assert.equal(clampAudioRate(-3.0), 0.25);
  });

  it("falls back to 1.0 for missing/falsy rates", () => {
    assert.equal(clampAudioRate(undefined), 1.0);
    assert.equal(clampAudioRate(null), 1.0);
    assert.equal(clampAudioRate(0), 1.0); // 0 is falsy → treated as unset
  });
});

// ─── clampKokoroSpeed (0.5–3.0, default 1.0) ─────────────────────────────────

describe("clampKokoroSpeed", () => {
  it("passes through speeds inside the range", () => {
    assert.equal(clampKokoroSpeed(1.0), 1.0);
    assert.equal(clampKokoroSpeed(2.0), 2.0);
    assert.equal(clampKokoroSpeed(0.5), 0.5);
  });

  it("clamps out-of-range speeds to the bounds", () => {
    assert.equal(clampKokoroSpeed(3.5), 3.0);
    assert.equal(clampKokoroSpeed(0.1), 0.5);
  });

  it("falls back to 1.0 for missing/falsy speeds", () => {
    assert.equal(clampKokoroSpeed(undefined), 1.0);
    assert.equal(clampKokoroSpeed(0), 1.0);
  });
});

// ─── speedToProsodyRate ───────────────────────────────────────────────────────

describe("speedToProsodyRate", () => {
  it("maps 1.0 to +0%", () => {
    assert.equal(speedToProsodyRate(1.0), "+0%");
  });

  it("maps faster speeds to positive percentages", () => {
    assert.equal(speedToProsodyRate(1.5), "+50%");
    assert.equal(speedToProsodyRate(2.0), "+100%");
  });

  it("maps slower speeds to negative percentages (no plus sign)", () => {
    assert.equal(speedToProsodyRate(0.75), "-25%");
    assert.equal(speedToProsodyRate(0.5), "-50%");
  });

  it("rounds to whole percent", () => {
    assert.equal(speedToProsodyRate(1.37), "+37%");
    assert.equal(speedToProsodyRate(1.26), "+26%");
  });
});

// ─── clampStartIndex (listening-queue resume position) ─────────────────────

describe("clampStartIndex", () => {
  it("passes through valid 0-based indices", () => {
    assert.equal(clampStartIndex(0, 5), 0);
    assert.equal(clampStartIndex(3, 5), 3);
    assert.equal(clampStartIndex(4, 5), 4); // last chunk
  });

  it("clamps negative and falsy starts to 0", () => {
    assert.equal(clampStartIndex(-2, 5), 0);
    assert.equal(clampStartIndex(null, 5), 0);
    assert.equal(clampStartIndex(undefined, 5), 0);
    assert.equal(clampStartIndex(NaN, 5), 0);
  });

  it("clamps a start beyond the end to the last chunk", () => {
    assert.equal(clampStartIndex(5, 5), 4);
    assert.equal(clampStartIndex(99, 5), 4);
  });

  it("floors fractional starts", () => {
    assert.equal(clampStartIndex(2.9, 5), 2);
  });

  it("returns 0 for an empty chunk list", () => {
    assert.equal(clampStartIndex(0, 0), 0);
    assert.equal(clampStartIndex(7, 0), 0);
    assert.equal(clampStartIndex(3, undefined), 0);
  });
});

// ─── getStreamElementsVoice ───────────────────────────────────────────────────

describe("getStreamElementsVoice", () => {
  it("maps known Edge voices to StreamElements names", () => {
    assert.equal(getStreamElementsVoice("en-GB-SoniaNeural"), "Amy");
    assert.equal(getStreamElementsVoice("en-GB-RyanNeural"), "Brian");
    assert.equal(getStreamElementsVoice("en-US-AriaNeural"), "Joanna");
    assert.equal(getStreamElementsVoice("en-AU-WilliamNeural"), "Russell");
  });

  it("falls back to Amy for unknown or missing voices", () => {
    assert.equal(getStreamElementsVoice("fr-FR-HenriNeural"), "Amy");
    assert.equal(getStreamElementsVoice(undefined), "Amy");
    assert.equal(getStreamElementsVoice(""), "Amy");
  });
});
