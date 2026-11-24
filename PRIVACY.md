# PageVoice Privacy Policy

_Last updated: 2026-11-24_

PageVoice is a browser extension that reads web articles aloud. This policy
explains what happens to your data when you use it.

## The short version

- PageVoice has **no accounts, no analytics, no telemetry, and no server of
  its own**. We cannot see what you read or listen to.
- Your article text stays in your browser **unless** you choose a cloud TTS
  engine — in that case, the text you asked to be read is sent directly from
  your browser to that provider, by that provider's own API.
- Your API keys are stored in your browser's extension storage, never sent
  anywhere except the provider they belong to.

## What stays on your device

- **Extracted article text.** When you open the popup or press Read, the text
  of the current page is extracted locally in your browser.
- If you use **Browser Local** voices (the `speechSynthesis` API) or a
  **local Kokoro server** (127.0.0.1:8881), the text never leaves your
  machine.
- **Settings and playback state** (engine, voice, speed) are stored in
  `chrome.storage` in your browser.

## What can leave your device, and only when you choose it

When you select a cloud TTS engine, PageVoice sends the text you asked to be
read directly to that provider so it can be converted to speech:

| Engine you choose | Provider that receives the text |
|---|---|
| Edge TTS | Microsoft speech endpoint (`speech.platform.bing.com`), with Google Translate TTS (`translate.google.com`) as fallback |
| OpenAI TTS | OpenAI (`api.openai.com`) — requires your API key |
| ElevenLabs | ElevenLabs (`api.elevenlabs.io`) — requires your API key |

We do not operate any intermediary server. Requests go browser → provider.
That provider's own privacy policy then applies to the text.

## API keys

If you paste an OpenAI or ElevenLabs API key, it is stored in the extension's
browser storage (`chrome.storage`). Note that `chrome.storage.sync` can
replicate stored data through **your own** Chrome profile sync — it is never
sent to us or to any party other than the provider the key belongs to.

## What we do not do

- No collection of browsing history or reading behavior
- No analytics, tracking pixels, or advertising
- No selling or sharing of data — there is nothing to sell
- No accounts, emails, or payments processed by the extension

## Permissions and why

- `activeTab` / `scripting` / `tabs` — extract the text of the page you are
  reading, on your action.
- `storage` — remember your settings and API keys locally.
- `offscreen` — keep audio playing after the popup closes.
- Host permissions for the TTS providers listed above, and `127.0.0.1:8881`
  for an optional self-hosted Kokoro server.

## Changes

Material changes to this policy will update the date above and ship with a
new extension release.

## Contact

- GitHub issues: https://github.com/h-mascot/pagevoice/issues
- Email: henrino3@gmail.com
