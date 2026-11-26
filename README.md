# 🔊 PageVoice

A Chrome extension that reads web articles aloud. Queue pages like a podcast,
follow along with karaoke-style word highlighting, import PDFs, and pick the
voice that fits: **Edge TTS** (default — free neural voices), **OpenAI** or
**ElevenLabs** (bring your own key), **local browser voices**, or optional
self-hosted **Kokoro**.

![PageVoice Preview](preview.png)

## Features

- 🎧 **Listening Queue** — save pages to a persistent playlist and play
  through like a podcast: auto-advance, per-item resume position,
  reorder/remove, and a live count badge
- 🖋️ **Word Highlighting** (opt-in) — karaoke-style highlighting synced to
  playback across every engine and speed, with auto-scroll to the sentence
  being read
- 📄 **PDF Import** — read local PDFs aloud (up to 50 MB) via button or
  drag-and-drop, with clear errors for encrypted, scanned, or oversized files
- ⌨️ **Keyboard Shortcuts** — play/pause, stop, and save-to-queue without
  opening the popup
- 🎯 **Read From Here** — right-click any paragraph (or select text) to start
  listening at that point
- 🖥️ **Kokoro Local Voice** — free self-hosted TTS with one-click detection
  and graceful fallback — see the [setup guide](docs/kokoro-setup.md)
- 📖 **Smart Article Extraction** — grabs the article, skips nav and clutter
- ⏯️ **Playback Controls** — play, pause, stop, and resume; audio survives
  closing the popup (offscreen document)
- ⚡ **Speed Control** — 0.5x to 3x
- 💾 **Persistent Settings** — preferences and queue saved across sessions
- 🌙 **Dark Mode UI**

## Installation

### Method 1: Load Unpacked (Developer Mode)

1. **Download or clone this repo:**

    git clone https://github.com/h-mascot/pagevoice.git

   Or download the ZIP and extract it.

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top-right corner)

4. Click **Load unpacked**

5. Select the `pagevoice` folder

6. Pin the extension: Click the puzzle piece icon in Chrome toolbar, find "PageVoice", click the pin

### Method 2: Pack the Extension

1. Go to `chrome://extensions/`
2. Click **Pack extension**
3. Select the `pagevoice` folder as the extension root
4. Chrome will create a `.crx` file you can install

## Usage

1. **Navigate to any article** or blog post

2. **Click the PageVoice icon** in your Chrome toolbar

3. **Choose your TTS engine:**
   - **Edge TTS** — natural neural voices, free, no key needed (default)
   - **Local TTS** — your browser's built-in OS voices (free, offline)
   - **OpenAI / ElevenLabs** — premium AI voices with your own API key
   - **Kokoro** — self-hosted at `127.0.0.1:8881` (see the
     [setup guide](docs/kokoro-setup.md); the popup detects it and shows
     server-reported voices)

4. **Select a voice** from the dropdown

5. **Adjust speed** if needed (default: 1x, range 0.5x–3x)

6. Click **▶️ Read** to start listening

### Listening queue

Save pages with the **＋ Save to queue** button (in the popup or on the
floating mini-player) or the `Alt+Shift+Q` shortcut. Open the queue with the
🎧 button in the popup: items play in order with auto-advance, each remembers
where you paused, and you can reorder or remove them. Playing a page directly
is separate — the queue keeps its own place.

### Word highlighting

Opt in from Settings (**Highlight words while reading**). The sentence being
read is highlighted with word-level tracking and auto-scroll; it stays in
sync across engines and playback speeds and clears instantly if you turn it
off.

### PDF import

In the queue view, click **📄** or drag a PDF file onto the queue to add it
as a listening item — or simply drop the PDF onto the page you're reading:
an overlay confirms the target, the import runs in the background, and a
small toast confirms when the item is queued. PDFs with a real text layer
work best; encrypted or scanned-only PDFs produce a clear error explaining
what to try instead.

### Keyboard shortcuts

PageVoice registers four global shortcuts that work even when the popup
is closed (playback lives in an offscreen document, so audio survives):

| Action | Default shortcut |
|---|---|
| Play / Pause | `Alt+Shift+P` |
| Stop | `Alt+Shift+S` |
| Save current page to the listening queue | `Alt+Shift+Q` |
| Read from here | `Alt+Shift+R` |

Play/Pause is a toggle: from a stopped state it starts reading the current
page. Rebind any shortcut at `chrome://extensions/shortcuts` (the "Keyboard
shortcuts" section at the bottom of the page) — keys are per-browser, and
clashes with other extensions are resolved there too.

### Read from here

Don't want to start at the top? Select some text and a small
**▶ Read from here** bubble appears under the selection — click it or press
`Alt+Shift+R` (the shortcut works from the paragraph you last right-clicked
too, even without a selection). Or right-click anywhere in the paragraph you
want to start from and choose **Read from here**; playback then starts at
the sentence your selection begins at. Works together with the floating
mini-player: it appears on the page with the usual controls.

### API keys (OpenAI / ElevenLabs)

1. Get an API key from [openai.com](https://platform.openai.com) or
   [elevenlabs.io](https://elevenlabs.io)
2. Paste it in the API Key field in settings
3. Select your preferred voice
4. Start reading!

Keys are stored in your browser only. See [PRIVACY.md](PRIVACY.md) for
exactly what data goes where.

## Available Voices

Voice options in the popup depend on the selected engine: Edge TTS neural
voices, your OS's built-in local voices, OpenAI and ElevenLabs premium
voices (with your own key), and the voice list your Kokoro server reports.

## Technical Details

- **Manifest Version:** 3 (MV3) — no build step; what's committed is what
  ships
- **Permissions:** storage, activeTab, scripting, offscreen, tabs, contextMenus
- **Keyboard commands:** play-pause, stop, save-to-queue (see `commands` in
  manifest.json)
- **Host permissions:** the TTS engine endpoints (ElevenLabs, OpenAI,
  StreamElements, Google Translate, Bing Speech for Edge TTS) plus
  `127.0.0.1:8881` for optional Kokoro — text only ever goes to the engine
  you select
- **Vendored libraries:** pdf.js pinned at 3.11.174 (see
  `vendor/pdfjs/VENDOR.md`) — no remote code, per MV3 policy

## Development

No build step — what's committed is what ships. Pure logic (text chunking,
queue operations, highlight alignment, PDF validation, engine probing) lives
in `lib/` modules with colocated tests:

```bash
npm test                # node --test (no dependencies required)
bash scripts/ctrl-gate-runner.sh   # syntax checks + unit tests (same as CI)
bash scripts/package-zip.sh        # build dist/pagevoice-<version>.zip (store upload)
```

## File Structure

```
pagevoice/
├── manifest.json       # Extension configuration (MV3)
├── popup.html/js/css   # Popup UI — player, settings, queue view
├── background.js       # Service worker — message routing, offscreen lifecycle
├── offscreen.html/js   # Persistent audio playback (survives popup close)
├── content.js          # Article extraction, mini-player, highlighting
├── content-player.css  # Floating mini-player styles
├── lib/                # Pure-logic modules + colocated node:test suites
├── vendor/pdfjs/       # Vendored pdf.js 3.11.174 (pinned, no remote code)
├── kokoro_server.py    # Optional self-hosted Kokoro TTS server (127.0.0.1:8881)
├── scripts/            # CI gate runner, fixtures, store-zip packager
├── icon-*.png          # Toolbar + store icons
├── README.md           # This file
├── CHANGELOG.md        # Release notes
├── PRIVACY.md          # Privacy policy (linked from store listing)
├── LICENSE             # MIT
└── docs/               # store-listing.md, kokoro-setup.md
```

## Troubleshooting

### "Could not extract text"
- Refresh the page and try again
- Some pages may block content scripts

### PDF import failed
- Encrypted: remove the password first
- Scanned/image-only: the PDF has no text layer — OCR it first
- Over 50 MB: split or compress the file

### Kokoro shows as unreachable
- See the [setup guide](docs/kokoro-setup.md) — start the server, then hit
  **Check again** in settings. If it stays down, playback falls back to
  local browser voices automatically.

### OpenAI / ElevenLabs not working
- Check your API key is valid
- Ensure you have API credits available

### No sound
- Check your system volume
- Try a different voice
- For local TTS, ensure your OS has voices installed

## License

MIT — see [LICENSE](LICENSE). Feel free to modify and distribute!

## Privacy

No accounts, no analytics, no telemetry. See [PRIVACY.md](PRIVACY.md) for
exactly what data goes where.

---

Made with ❤️ by [Henry Mascot](https://github.com/henrino3)
