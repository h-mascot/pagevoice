# Changelog

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
