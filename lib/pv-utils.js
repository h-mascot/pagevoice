/**
 * lib/pv-utils.js — PageVoice pure logic
 *
 * Side-effect-free helpers used by offscreen.js: text chunking, sentence
 * splitting, speed clamping, XML escaping, and the StreamElements voice
 * mapping. Kept in a separate file so they can be unit-tested with
 * `node --test` (colocated pv-utils.test.js) per TESTING.md — DOM/network
 * wiring stays in offscreen.js.
 *
 * Loading (no build step, MV3-safe): offscreen.html loads this file as a
 * classic script BEFORE offscreen.js, so the top-level declarations below
 * are globals for offscreen.js. The Node export block at the bottom is
 * inert in the browser.
 */

// ─── StreamElements voice mapping (Edge TTS fallback path) ───────────────────

const EDGE_STREAMELEMENTS_VOICE_MAP = {
  "en-GB-SoniaNeural":   "Amy",
  "en-GB-RyanNeural":    "Brian",
  "en-US-JennyNeural":   "Joanna",
  "en-US-GuyNeural":     "Matthew",
  "en-AU-NatashaNeural": "Nicole",
  "en-AU-WilliamNeural": "Russell",
  "en-US-AriaNeural":    "Joanna",
};

function getStreamElementsVoice(voiceName) {
  return EDGE_STREAMELEMENTS_VOICE_MAP[voiceName] || "Amy";
}

// ─── XML escaping (Edge TTS SSML) ────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Speed clamping ──────────────────────────────────────────────────────────
// Audio playback rate and the OpenAI TTS request speed share the 0.25–4.0
// range; Kokoro accepts 0.5–3.0. Falsy/absent values fall back to 1.0.

function clampAudioRate(rate) {
  return Math.min(4.0, Math.max(0.25, rate || 1.0));
}

function clampKokoroSpeed(rate) {
  return Math.min(3.0, Math.max(0.5, rate || 1.0));
}

// ─── Resume-position clamping (listening queue) ─────────────────────────────

// Clamp a 0-based chunk index for resuming playback: falsy/negative → 0,
// beyond the end → the last chunk. An empty chunk list resumes at 0.
function clampStartIndex(startChunk, totalChunks) {
  const total = Math.max(0, Math.floor(totalChunks || 0));
  if (total === 0) return 0;
  const start = Math.floor(startChunk || 0);
  if (start < 0) return 0;
  return Math.min(total - 1, start);
}

// ─── Edge TTS prosody conversion ─────────────────────────────────────────────

// Convert numeric speed (1.0) to an Edge TTS prosody rate string
// ("+0%", "+50%", "-25%", …).

function speedToProsodyRate(speedRate) {
  const pct = Math.round((speedRate - 1) * 100);
  return (pct >= 0 ? "+" : "") + pct + "%";
}

// ─── Sentence splitting / text chunking ──────────────────────────────────────

function splitIntoSentences(text) {
  const input = (text || "").trim();
  if (!input) return [];
  return (input.match(/[^.!?]+(?:[.!?]+|$)/g) || [input])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

// Chunk the text while remembering sentence provenance: each chunk is
// { text, sentenceStart, sentenceCount } — the 0-based range of sentences
// (as produced by splitIntoSentences) it covers. A sentence longer than
// maxLen is hard-split into several chunks that all carry the same sentence
// index (count 1). This is the highlighting sync primitive (issue #4):
// offscreen.js uses it to map chunk/word progress back to a global sentence
// index that content.js agrees on (both call splitIntoSentences on the same
// article text).
function buildTextChunks(text, maxLen) {
  const sentences = splitIntoSentences(text);
  const chunks    = [];
  let cur         = null; // { text, sentenceStart, sentenceCount }

  const flush = () => {
    if (cur && cur.text.trim()) chunks.push(cur);
    cur = null;
  };

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.length > maxLen) {
      // Very long sentence: split by commas or just cut hard
      flush();
      const parts = s.match(new RegExp(`.{1,${maxLen}}`, "g")) || [s];
      parts.forEach((p) => chunks.push({ text: p.trim(), sentenceStart: i, sentenceCount: 1 }));
    } else {
      const joined = cur ? `${cur.text} ${s}` : s;
      if (joined.length > maxLen) {
        flush();
        cur = { text: s, sentenceStart: i, sentenceCount: 1 };
      } else if (cur) {
        cur = {
          text:           joined,
          sentenceStart:  cur.sentenceStart,
          sentenceCount:  cur.sentenceCount + 1,
        };
      } else {
        cur = { text: s, sentenceStart: i, sentenceCount: 1 };
      }
    }
  }

  flush();
  return chunks;
}

// Plain-string chunking (same boundaries as buildTextChunks).
function splitText(text, maxLen) {
  return buildTextChunks(text, maxLen)
    .map((chunk) => chunk.text)
    .filter(Boolean);
}

// ─── Node test-runner export (inert in the browser) ─────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    EDGE_STREAMELEMENTS_VOICE_MAP,
    getStreamElementsVoice,
    escapeXml,
    clampAudioRate,
    clampKokoroSpeed,
    clampStartIndex,
    speedToProsodyRate,
    splitIntoSentences,
    buildTextChunks,
    splitText,
  };
}
