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

function splitText(text, maxLen) {
  const chunks    = [];
  const sentences = splitIntoSentences(text);
  let   chunk     = "";

  for (const s of sentences) {
    if (s.length > maxLen) {
      // Very long sentence: split by commas or just cut hard
      if (chunk) { chunks.push(chunk.trim()); chunk = ""; }
      const parts = s.match(new RegExp(`.{1,${maxLen}}`, "g")) || [s];
      parts.forEach((p) => chunks.push(p.trim()));
    } else if ((chunk ? `${chunk} ${s}` : s).length > maxLen) {
      if (chunk) chunks.push(chunk.trim());
      chunk = s;
    } else {
      chunk = chunk ? `${chunk} ${s}` : s;
    }
  }

  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks.filter(Boolean);
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
    splitText,
  };
}
