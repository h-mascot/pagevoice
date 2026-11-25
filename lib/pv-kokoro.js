/**
 * lib/pv-kokoro.js — Kokoro local-server probe + voice-list logic (issue #7)
 *
 * Pure functions only: URL building, /v1/voices response parsing, failure
 * classification, operator copy, and voice-list resolution. All network
 * I/O lives in background.js (settings "Check again" probe) and
 * offscreen.js (pre-playback probe + mid-stream failure fallback); both
 * call classify/parse from here so the rules are unit-tested exactly once.
 *
 * Kokoro voice ids encode region + gender in the prefix: "af_heart" =
 * American female, "bm_george" = British male. kokoroVoiceLabel() derives
 * friendly labels from the prefix, so server-provided ids we have never
 * seen still label correctly.
 *
 * Loaded as a classic script by offscreen.html and popup.html (globals),
 * and imported by lib/pv-kokoro.test.js under `node --test`.
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

const KOKORO_BASE_URL = "http://127.0.0.1:8881";
const KOKORO_PROBE_PATH = "/v1/voices";
const KOKORO_PROBE_TIMEOUT_MS = 2500;

// Kokoro v1.0 English voices, mirroring kokoro_server.py's /v1/voices.
// Used as the picker list when the server is unreachable or serves no
// list, so the engine remains selectable (and honest) at all times.
const DEFAULT_KOKORO_VOICE_IDS = [
  "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore",
  "af_sarah", "af_nova", "af_sky",
  "am_adam", "am_michael", "am_onyx", "am_puck",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_KOKORO_VOICES = DEFAULT_KOKORO_VOICE_IDS.map((id) => ({
  value: id,
  label: kokoroVoiceLabel(id),
}));

// ─── URL + labels ─────────────────────────────────────────────────────────────

function kokoroVoicesUrl(baseUrl) {
  const base = (typeof baseUrl === "string" && baseUrl.trim())
    ? baseUrl
    : KOKORO_BASE_URL;
  return base.replace(/\/+$/, "") + KOKORO_PROBE_PATH;
}

function kokoroVoiceLabel(id) {
  if (typeof id !== "string" || !id.trim()) return "";
  const m = /^([ab])([fm])_([a-z0-9]+)$/.exec(id.trim().toLowerCase());
  if (!m) return prettifyKokoroId(id);
  const region = m[1] === "a" ? "US" : "British";
  const gender = m[2] === "f" ? "Female" : "Male";
  const name   = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  return `${name} (${region} ${gender})`;
}

function prettifyKokoroId(id) {
  return id.trim().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── /v1/voices parsing ───────────────────────────────────────────────────────

/**
 * Parse a /v1/voices body into [{value, label}].
 * Accepts: {"voices": ["af_heart", ...]}, {"voices": [{"id"|"voice"|"value",
 * "name"?}, ...]}, a bare array, or any of those as a JSON string.
 * Returns null when nothing parseable — callers then fall back to the
 * default list. Never throws.
 */
function parseKokoroVoices(body) {
  let data = body;
  if (typeof data === "string") {
    const s = data.trim();
    if (!s) return null;
    try { data = JSON.parse(s); } catch { return null; }
  }
  if (data === null || typeof data !== "object") return null;

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.voices) ? data.voices : null;
  if (!list) return null;

  const seen = new Set();
  const out = [];
  for (const entry of list) {
    let value = null;
    let label = null;
    if (typeof entry === "string") {
      value = entry.trim();
    } else if (entry && typeof entry === "object") {
      value = [entry.id, entry.voice, entry.value]
        .find((v) => typeof v === "string" && v.trim()) || null;
      label = [entry.name, entry.label]
        .find((v) => typeof v === "string" && v.trim()) || null;
    }
    if (!value) continue;           // unidentifiable entry — skip, don't fail
    if (seen.has(value)) continue;  // server lists stay deduped
    seen.add(value);
    out.push({ value, label: label || kokoroVoiceLabel(value) });
  }
  return out.length ? out : null;
}

// ─── Failure classification + fallback policy ─────────────────────────────────

/**
 * Classify a Kokoro fetch failure:
 *   "timeout"     — probe/TTS request exceeded its deadline (AbortError
 *                   from a controller, "timed out" from fetchWithTimeout)
 *   "unreachable" — connection-level failure (Chrome "Failed to fetch",
 *                   Safari "Load failed", ECONNREFUSED-family)
 *   "http"        — the server answered with an HTTP error status
 *   "unknown"     — anything else
 * Checks err.name as well as err.message (an AbortController rejection
 * often has a name but no useful message).
 */
function classifyKokoroFailure(err) {
  const msg = String((err && (err.message || err.name)) || err || "");
  if (!msg) return "unknown";
  if (/timed?\s?out|aborterror|aborted|signal is aborted/i.test(msg)) return "timeout";
  if (/failed to fetch|networkerror|load failed|econnrefused|err_connection|connection refused|fetch failed/i.test(msg)) {
    return "unreachable";
  }
  if (/kokoro api \d+|http \d+|^5\d\d$|^4\d\d$/i.test(msg)) return "http";
  return "unknown";
}

/**
 * Only connection-level failures fall back to Browser Local voices: an
 * HTTP error means the server IS running and the request itself failed —
 * stopping with the error message is the honest behavior (no silent
 * substitution when the operator can fix the server).
 */
function shouldFallbackToBrowserLocal(failure) {
  return failure === "unreachable" || failure === "timeout";
}

// ─── Operator copy ────────────────────────────────────────────────────────────

function kokoroFallbackNotice(failure, baseUrl) {
  const host = (baseUrl || KOKORO_BASE_URL).replace(/^https?:\/\//, "");
  return failure === "timeout"
    ? `Kokoro server at ${host} is not responding — reading with Browser Local voices instead.`
    : `Kokoro server at ${host} is not reachable — reading with Browser Local voices instead (start it with: python kokoro_server.py)`;
}

/**
 * Settings status-line copy for a probe result
 * ({reachable, voices, failure}).
 */
function kokoroStatusText(status) {
  const host = KOKORO_BASE_URL.replace(/^https?:\/\//, "");
  if (status && status.reachable) {
    const count = Array.isArray(status.voices) ? status.voices.length : 0;
    return count
      ? `Kokoro (${host}): running ✓ · ${count} voices`
      : `Kokoro (${host}): running ✓`;
  }
  return `Kokoro (${host}): not running ✗ — falls back to Browser Local`;
}

// ─── Voice-list resolution ────────────────────────────────────────────────────

/**
 * Voice-picker options: the server list when present, else the curated
 * defaults. Returns fresh copies so callers cannot mutate the default
 * table.
 */
function resolveKokoroVoiceOptions(serverVoices) {
  if (Array.isArray(serverVoices) && serverVoices.length) {
    return serverVoices.map((v) => ({ value: v.value, label: v.label }));
  }
  return DEFAULT_KOKORO_VOICES.map((v) => ({ ...v }));
}

// ─── Node test-runner export (inert in the browser) ─────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    KOKORO_BASE_URL,
    KOKORO_PROBE_PATH,
    KOKORO_PROBE_TIMEOUT_MS,
    DEFAULT_KOKORO_VOICE_IDS,
    DEFAULT_KOKORO_VOICES,
    kokoroVoicesUrl,
    kokoroVoiceLabel,
    parseKokoroVoices,
    classifyKokoroFailure,
    shouldFallbackToBrowserLocal,
    kokoroFallbackNotice,
    kokoroStatusText,
    resolveKokoroVoiceOptions,
  };
}
