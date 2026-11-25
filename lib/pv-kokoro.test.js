// Colocated tests for lib/pv-kokoro.js (issue #7 — Kokoro probe/fallback
// pure logic). Run with `node --test` via `npm test`.

const { test } = require("node:test");
const assert = require("node:assert");

const {
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
} = require("./pv-kokoro.js");

// ─── constants sanity ─────────────────────────────────────────────────────────

test("constants point at the documented local server", () => {
  assert.equal(KOKORO_BASE_URL, "http://127.0.0.1:8881");
  assert.equal(KOKORO_PROBE_PATH, "/v1/voices");
  assert.ok(KOKORO_PROBE_TIMEOUT_MS >= 1000 && KOKORO_PROBE_TIMEOUT_MS <= 5000);
});

test("default voice table is unique, non-empty, and fully labeled", () => {
  assert.ok(DEFAULT_KOKORO_VOICE_IDS.length >= 12);
  const values = DEFAULT_KOKORO_VOICES.map((v) => v.value);
  assert.equal(new Set(values).size, values.length, "no duplicate voices");
  assert.ok(values.includes("af_heart"));
  assert.ok(values.includes("bf_alice"));
  for (const v of DEFAULT_KOKORO_VOICES) {
    assert.equal(typeof v.value, "string");
    assert.ok(v.label.length > 0, `label for ${v.value}`);
  }
});

// ─── kokoroVoicesUrl ──────────────────────────────────────────────────────────

test("kokoroVoicesUrl: default base", () => {
  assert.equal(kokoroVoicesUrl(), "http://127.0.0.1:8881/v1/voices");
});

test("kokoroVoicesUrl: custom base with trailing slash", () => {
  assert.equal(
    kokoroVoicesUrl("http://localhost:9000///"),
    "http://localhost:9000/v1/voices"
  );
});

test("kokoroVoicesUrl: empty/invalid base falls back to default", () => {
  assert.equal(kokoroVoicesUrl(""), KOKORO_BASE_URL + KOKORO_PROBE_PATH);
  assert.equal(kokoroVoicesUrl(null), KOKORO_BASE_URL + KOKORO_PROBE_PATH);
  assert.equal(kokoroVoicesUrl(undefined), KOKORO_BASE_URL + KOKORO_PROBE_PATH);
});

// ─── kokoroVoiceLabel ─────────────────────────────────────────────────────────

test("kokoroVoiceLabel derives region + gender from the id prefix", () => {
  assert.equal(kokoroVoiceLabel("af_heart"), "Heart (US Female)");
  assert.equal(kokoroVoiceLabel("am_michael"), "Michael (US Male)");
  assert.equal(kokoroVoiceLabel("bf_alice"), "Alice (British Female)");
  assert.equal(kokoroVoiceLabel("bm_george"), "George (British Male)");
});

test("kokoroVoiceLabel tolerates case and whitespace", () => {
  assert.equal(kokoroVoiceLabel(" AF_Heart "), "Heart (US Female)");
});

test("kokoroVoiceLabel prettifies non-conforming ids instead of failing", () => {
  assert.equal(kokoroVoiceLabel("voice-one"), "Voice One");
  assert.equal(kokoroVoiceLabel(""), "");
  assert.equal(kokoroVoiceLabel(null), "");
});

test("kokoroVoiceLabel labels every default id without falling to prettify", () => {
  for (const id of DEFAULT_KOKORO_VOICE_IDS) {
    assert.match(kokoroVoiceLabel(id), /\((US|British) (Female|Male)\)$/);
  }
});

// ─── parseKokoroVoices ────────────────────────────────────────────────────────

test("parseKokoroVoices: {voices: [ids]} shape from kokoro_server.py", () => {
  const out = parseKokoroVoices(JSON.stringify({ voices: ["af_heart", "bm_george"] }));
  assert.deepEqual(out, [
    { value: "af_heart", label: "Heart (US Female)" },
    { value: "bm_george", label: "George (British Male)" },
  ]);
});

test("parseKokoroVoices: object entries with id + name keep the server label", () => {
  const out = parseKokoroVoices({ voices: [
    { id: "af_heart", name: "Heart" },
    { voice: "af_bella" },
  ]});
  assert.deepEqual(out, [
    { value: "af_heart", label: "Heart" },
    { value: "af_bella", label: "Bella (US Female)" },
  ]);
});

test("parseKokoroVoices: bare array shape", () => {
  const out = parseKokoroVoices(["am_onyx"]);
  assert.deepEqual(out, [{ value: "am_onyx", label: "Onyx (US Male)" }]);
});

test("parseKokoroVoices: already-parsed object passes through", () => {
  const body = { voices: [{ value: "af_sky", label: "Sky" }] };
  const out = parseKokoroVoices(body);
  assert.deepEqual(out, [{ value: "af_sky", label: "Sky" }]);
});

test("parseKokoroVoices: dedupes and drops junk entries", () => {
  const out = parseKokoroVoices({
    voices: ["af_heart", "af_heart", "", null, { nope: 1 }, "bf_lily", "   "],
  });
  assert.deepEqual(out, [
    { value: "af_heart", label: "Heart (US Female)" },
    { value: "bf_lily",  label: "Lily (British Female)" },
  ]);
});

test("parseKokoroVoices: unparseable inputs return null, never throw", () => {
  for (const bad of ["", "   ", "not json", "{", "null", "42", '"str"',
                     {}, { voices: [] }, [], { voices: "af_heart" },
                     { voices: [null, 3, {}] }, null, undefined, 42]) {
    assert.equal(parseKokoroVoices(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ─── classifyKokoroFailure ────────────────────────────────────────────────────

test("classifyKokoroFailure: connection-level errors → unreachable", () => {
  assert.equal(classifyKokoroFailure(new Error("Failed to fetch")), "unreachable");
  assert.equal(classifyKokoroFailure(new TypeError("Failed to fetch")), "unreachable");
  assert.equal(classifyKokoroFailure(new Error("Load failed")), "unreachable");
  assert.equal(classifyKokoroFailure(new Error("connect ECONNREFUSED 127.0.0.1:8881")), "unreachable");
});

test("classifyKokoroFailure: deadline errors → timeout (incl. AbortError name)", () => {
  assert.equal(classifyKokoroFailure(new Error("Kokoro request timed out after 60s")), "timeout");
  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  assert.equal(classifyKokoroFailure(abortErr), "timeout");
  // AbortController rejections often carry only a message
  assert.equal(classifyKokoroFailure(new Error("signal is aborted without reason")), "timeout");
});

test("classifyKokoroFailure: HTTP status errors → http", () => {
  assert.equal(classifyKokoroFailure(new Error("Kokoro API 500: Internal Server Error")), "http");
  assert.equal(classifyKokoroFailure(new Error("HTTP 404")), "http");
});

test("classifyKokoroFailure: anything else → unknown", () => {
  assert.equal(classifyKokoroFailure(new Error("something odd")), "unknown");
  assert.equal(classifyKokoroFailure(null), "unknown");
  assert.equal(classifyKokoroFailure(undefined), "unknown");
});

// ─── fallback policy ──────────────────────────────────────────────────────────

test("shouldFallbackToBrowserLocal: connection failures only", () => {
  assert.equal(shouldFallbackToBrowserLocal("unreachable"), true);
  assert.equal(shouldFallbackToBrowserLocal("timeout"), true);
  assert.equal(shouldFallbackToBrowserLocal("http"), false);
  assert.equal(shouldFallbackToBrowserLocal("unknown"), false);
});

// ─── operator copy ────────────────────────────────────────────────────────────

test("kokoroFallbackNotice: unreachable copy names the host + remedy", () => {
  const text = kokoroFallbackNotice("unreachable");
  assert.match(text, /127\.0\.0\.1:8881/);
  assert.match(text, /Browser Local/);
  assert.match(text, /kokoro_server\.py/);
});

test("kokoroFallbackNotice: timeout copy is distinct and names Browser Local", () => {
  const text = kokoroFallbackNotice("timeout");
  assert.match(text, /not responding/);
  assert.match(text, /Browser Local/);
  assert.notEqual(text, kokoroFallbackNotice("unreachable"));
});

test("kokoroStatusText: reachable with/without voice count", () => {
  assert.equal(
    kokoroStatusText({ reachable: true, voices: [{}, {}, {}] }),
    "Kokoro (127.0.0.1:8881): running ✓ · 3 voices"
  );
  assert.equal(kokoroStatusText({ reachable: true, voices: null }),
    "Kokoro (127.0.0.1:8881): running ✓");
});

test("kokoroStatusText: unreachable copy mentions the fallback", () => {
  assert.match(kokoroStatusText({ reachable: false }), /not running ✗/);
  assert.match(kokoroStatusText({ reachable: false }), /Browser Local/);
  assert.match(kokoroStatusText(null), /not running ✗/);
});

// ─── resolveKokoroVoiceOptions ────────────────────────────────────────────────

test("resolveKokoroVoiceOptions: server list wins when present", () => {
  const server = [{ value: "af_nova", label: "Nova (US Female)" }];
  const out = resolveKokoroVoiceOptions(server);
  assert.deepEqual(out, server);
  // copies, not the caller's objects
  assert.notEqual(out[0], server[0]);
});

test("resolveKokoroVoiceOptions: null/empty falls back to defaults (copied)", () => {
  for (const empty of [null, undefined, []]) {
    const out = resolveKokoroVoiceOptions(empty);
    assert.equal(out.length, DEFAULT_KOKORO_VOICES.length);
    assert.deepEqual(out[0], DEFAULT_KOKORO_VOICES[0]);
    assert.notEqual(out, DEFAULT_KOKORO_VOICES);
    out.pop(); // must not mutate the default table
    assert.equal(DEFAULT_KOKORO_VOICES.length, out.length + 1);
  }
});
