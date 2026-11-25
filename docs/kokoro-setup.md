# Kokoro local voice — setup guide

Kokoro is a free, high-quality TTS model that runs **entirely on your
machine** — no API key, no cloud, no per-character cost. PageVoice detects
it automatically. Setting it up takes two steps.

## 1. Install

Requires Python 3.10+.

```bash
pip install kokoro fastapi uvicorn soundfile
```

The first run downloads the model (~300 MB) and caches it locally.

## 2. Run

From the PageVoice repo:

```bash
python kokoro_server.py
```

Leave it running. It serves `http://127.0.0.1:8881` (localhost only —
it is not reachable from your network because the extension only ever
talks to 127.0.0.1).

That's it. Open PageVoice → ⚙️ Settings → **Check again**: the status
line should read `Kokoro (127.0.0.1:8881): running ✓` and the Kokoro TTS
engine picks up its live voice list.

## What the extension expects

| Endpoint | Used for |
|---|---|
| `GET /v1/voices` | Liveness probe + voice list (Settings status line, voice picker) |
| `POST /v1/text-to-speech/{voice_id}` | Synthesis — JSON body `{ "text": "...", "speed": 1.0 }`, returns WAV audio (24 kHz) |

Both are served by `kokoro_server.py` with CORS enabled, so nothing else
to configure. The extension only needs the `http://127.0.0.1:8881/*` host
permission it already has.

Voice ids look like `af_heart` (`a`=American, `b`=British; `f`=female,
`m`=male), so any voice the server offers labels itself correctly in the
picker — including ones we've never curated.

## When the server is not running

Nothing breaks silently:

- Settings shows `not running ✗` and links back to this guide.
- If you press Play with Kokoro selected, PageVoice reads the page with
  **Browser Local voices instead** and tells you in the status line —
  playback never just dies. Start the server and press Play again to get
  Kokoro back.

## Verify it works

```bash
curl http://127.0.0.1:8881/v1/voices
# → {"voices":["af_heart","af_bella",...]}
```

Then read any article with the engine set to Kokoro TTS.
