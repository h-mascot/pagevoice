# Changelog

## v2.2.2 — 2026-11-26

Operator verification round 2 (issues #19/#20/#21 fix wave). 236 tests (was
215), all green at baseline speed. Fix method per the round-2 standing
lesson: real-path evidence (real message-serialization semantics in CI +
channel smoke with recorded output), not green unit tests alone.

### Fixed

- **PDF import broken end-to-end (#20)** — both the file-pick and the
  page-level drop paths died with "No PDF data received — pick the file
  again." Root cause: `chrome.runtime.sendMessage` JSON-serializes messages,
  so the `{ buffer: ArrayBuffer }` payload arrived as a plain empty object
  and the `instanceof ArrayBuffer` check in background failed. Pure-logic
  unit tests never caught it because the real channel semantics were never
  exercised. The bytes now travel as base64 STRING chunks over a
  begin/chunk/end protocol (`lib/pv-transport.js`, 2 MiB chunks, 60 s
  session GC) on BOTH hops (sender→background and background→offscreen);
  new channel-semantics tests round-trip every message through
  `JSON.parse(JSON.stringify(msg))` — the exact semantics that broke
  v2.2.1 — and a vm smoke drives the real background.js + offscreen.js
  routers over a JSON-serializing channel end-to-end.
- **Highlighting regression (#19)** — the v2.2.1 long-range re-anchor
  (`findResyncLong`) took the FIRST 12-gram occurrence with no validation;
  on repetitive text that is routinely a wrong distant duplicate, and every
  later sentence then mapped onto it (the highlight "jumped to the wrong
  distant sentence" — worse than round 1). Resync now enumerates windowed +
  long-range candidates and validates: small jumps (≤64 chars) are trusted
  as local edits, large jumps need ≥96 chars of multi-sentence corroboration
  (or end-of-stream), the smallest validated jump wins, backward extension
  is bounded, and the DOM-walk fallback no longer borrows a distant
  sentence's identity (the highlight freezes gracefully instead). When
  nothing validates, positions stay unmapped. Regression tests reproduce
  the round-2 failure on the old code (60-sentence substitution sweep:
  58/60 sentences mapped to the wrong source sentence before, 0/60 after;
  the monotone and hidden-block tests fail there too).
- **Hotkey chip styling (#21)** — the shortcut key chips in the popup
  (`.shortcut-hints .key`) had a near-white `#e5e7eb` background clashing
  with the dark UI; the on-page read-from-here chip
  (`.pv-hint-key`) washed out to a pale background. Both are now dark
  key-caps matching the theme tokens.

## v2.2.1 — 2026-11-26

Operator verification round 1 (issue #15 fix wave): highlight drift fix plus
two discoverability fixes. 215 tests (was 193), all green at baseline speed.

### Fixed

- **Highlight drift (#15)** — highlighting now tracks the spoken word within
  one word across speeds 0.5x–3x on both engines, and lands on the right
  sentence. Three mechanisms fixed: (1) Web Speech `onboundary` reports
  `charIndex` into the RAW sentence text — it was being fed to the
  normalized-position word counter, drifting forward past collapsed
  whitespace (new `wordOrdinalAtRawChar`); (2) Edge TTS WordBoundary events
  don't map 1:1 to whitespace tokens ("1,000" → "one" + "thousand") — the
  ordinal-based mapping shifted for the rest of the chunk (new
  position-matching `mapWordEventsToCharOffsets` +
  `charOffsetToSentenceWord`); (3) Kokoro estimates the word from the audio
  fraction — over a 2500-char multi-sentence chunk that drifted by whole
  sentences (Kokoro now chunks per sentence via `buildSentenceChunks`/
  `buildEngineChunks`). The DOM-walk↔innerText alignment also survives
  >512-char hidden-text insertions (cookie banners, collapsed accordions)
  instead of orphaning every sentence after them, and rejects false resync
  anchors on repetitive sentence tails. Regression tests written first and
  verified failing on the drift before the fix landed.

### Added

- **Read-from-here shortcut + visible hint (#16)** — `Alt+Shift+R` command
  (manifest, same handler as the context menu), a clickable
  **▶ Read from here** bubble under any selection, shortcut hints in the
  popup, and updated docs.
- **Page-level PDF drop (#17)** — dropping a PDF anywhere on the page shows
  a full-viewport overlay and imports through the same background pipeline
  as the queue view; in-page toast feedback; popup path unchanged.

## v2.2.0 — 2026-11-25

Phase 1 "daily-habit" release: five features, each shipped as its own PR with
colocated tests (193 total, all green), on top of a new test foundation.

### Added

- **Listening queue** (#9) — save any page to a persistent playlist
  (`chrome.storage.local`, schema-versioned) and play through like a podcast:
  auto-advance on natural finish, per-item resume position, reorder/remove,
  live count badge in the popup, and a ＋ save button on the page
  mini-player. The queue keeps its own place — plain page playback is
  separate.
- **Word highlighting** (#10) — opt-in karaoke-style highlighting synced to
  playback on every engine and speed: layout-safe DOM wrapping, sentence
  auto-scroll, exact word timing on Edge TTS, proportional tracking on the
  others, instant clear on opt-out.
- **Keyboard shortcuts + read-from-here** (#11) — global `Alt+Shift+P / S / Q`
  commands (rebindable at chrome://extensions/shortcuts) driving the same
  playback core as the popup, and a right-click **Read from here** on any
  paragraph or selection.
- **PDF import** (#12) — read local PDFs aloud (up to 50 MB) from the queue
  view's 📄 button or drag-and-drop. pdf.js vendored at 3.11.174 (no remote
  code, MV3-safe worker loading); clear operator-facing errors for
  encrypted, scanned-only, and oversized files.
- **Kokoro one-click detection** (#13) — optional self-hosted Kokoro TTS at
  `127.0.0.1:8881`: live status in settings, dynamic voice list from the
  server, a two-step setup guide, and graceful fallback to browser voices
  when the server is down.
- **Test foundation** (#8) — `node --test` runner wired into `npm test` and
  CI; pure logic extracted into `lib/` modules with colocated suites
  (pv-utils, pv-queue, pv-highlight, pv-shortcuts, pv-pdf, pv-kokoro).

### Fixed

- Kokoro queue items now auto-advance like every other engine (the finish
  marker was not being matched).
- A dead Kokoro server no longer stalls playback for 60 s — the probe fails
  fast and playback falls back to local voices with a clear notice.
- A failed PDF.js script load no longer bricks later imports until reload
  (cached rejected promise now resets).

### Notes

- Manifest 2.1.0 → 2.2.0; full regression green (193/193 tests, CI).
- `scripts/package-zip.sh` builds the Chrome Web Store upload zip.

## v2.1.0

Initial public groundwork: article extraction, five TTS engines (Edge TTS,
OpenAI, ElevenLabs, browser local, StreamElements), offscreen audio that
survives popup close, floating mini-player, MIT license, privacy policy, and
the store-listing draft.
