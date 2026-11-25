# Vision

PageVoice turns reading into listening — anywhere, on the user's terms.

## Who it serves

People who want their eyes back: commuters catching up on articles, cooks and
gym-goers, students, and readers with dyslexia, low vision, or ADHD.

**Lead wedge:** private-by-default listening. Local voices that never leave
the device stay free forever; premium cloud voices (OpenAI / ElevenLabs) are
optional, bring-your-own-key today and a paid tier later. No accounts, no
analytics, no telemetry — text goes only to the engine the user picks.

## Positioning

- Free-forever local voices (zero marginal cost) vs. incumbents' paywalls
- Privacy-first: with local voices, article text never leaves the device
- Start in the browser, expand to reading anything on screen

## Roadmap

### Phase 1 — make the extension a daily habit
- [ ] Listening queue: save articles to a playlist, play through like a podcast
- [ ] Word-level highlighting while reading (toggleable)
- [ ] PDF / EPUB import
- [ ] Keyboard shortcuts + "read from here"
- [ ] Local voice polish: one-click Kokoro setup, auto-detect, clear status

### Phase 2 — beyond the browser
- [ ] macOS app: select-to-read hotkey in any app (accessibility API)
- [ ] macOS app: screenshot-region OCR → read
- [ ] Windows port

### Phase 3 — mobile
- [ ] Share-sheet ingestion on iOS / Android
- [ ] Camera scan → read

### Phase 4 — the business layer
- [ ] Cross-device sync of queue / position / voice picks
- [ ] Premium cloud-voice tier (paid)
- [ ] Optional publisher embed ("Listen to this article" button)

## Non-goals (standing)

- No accounts, telemetry, or analytics — structural, not just policy
- No remote code in the extension (Manifest V3 compliance)
- No hovering screen-reader overlay on mobile — OS restrictions make the
  share sheet + camera scan the honest equivalent
