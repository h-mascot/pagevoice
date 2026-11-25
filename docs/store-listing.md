# Chrome Web Store Listing — Draft

Everything needed for the first submission. Owner account actions marked
**[human]**.

## Store account prerequisites **[human]**

- [ ] Register Chrome Web Store developer account — one-time **$5 fee**
- [ ] Enable **2-Step Verification** on that Google account (required before
      publishing)
- [ ] Decide publisher display name (suggest: `Henry Mascot` or `PageVoice`)

## Listing identity

- **Name:** PageVoice — Read Articles Aloud
- **Summary** (≤132 chars):
  `Read any web article aloud. Free offline voices, Edge TTS, or premium AI voices from OpenAI and ElevenLabs. Bring your own key.`
- **Category:** Productivity → Accessibility
- **Language:** English

## Detailed description

PageVoice turns any article, blog post, or documentation page into audio you
can listen to while you do something else.

CHOOSE YOUR VOICE
• Browser Local — built-in OS voices. Free, offline, no key, nothing leaves
  your device.
• Edge TTS — natural neural voices, free, no account needed.
• OpenAI TTS — premium voices with your own API key.
• ElevenLabs — lifelike voices with your own API key.

WHY PEOPLE USE IT
• Catch up on reading while commuting, cooking, or at the gym
• Give your eyes a break from screens
• Supports dyslexia, low vision, and ADHD reading workflows
• Works on documentation, wikis, long-form journalism, and blogs

FEATURES
• Smart article extraction — grabs the article, skips nav and clutter
• Playback that survives closing the popup (offscreen audio)
• Keyboard shortcuts — play/pause, stop, and save-to-queue without opening
  the popup (defaults Alt+Shift+P / S / Q, rebindable at
  chrome://extensions/shortcuts)
• Read from here — right-click a paragraph, or select text and right-click,
  to start listening at that point
• Speed control from 0.5x to 3x
• Floating mini-player on the page
• Settings and voices persist across sessions
• Private by design: no accounts, no analytics, no telemetry. Text only ever
  goes to the TTS engine YOU pick — and with local voices it never leaves
  your device.

Bring your own API key for paid engines — PageVoice never proxies or resells
voice minutes.

PRIVACY
See PRIVACY.md in the repository. No data collection, no tracking.

## Screenshots (1280x800 or 640x400) — to capture **[human or agent]**

1. Popup open on a long article, engine selector visible
2. Floating mini-player mid-article with play/pause controls
3. Settings view with API key field + voice dropdown
4. Optional: dark-mode variant

## Privacy tab answers (developer dashboard)

- **Single purpose:** Read web article text aloud using the text-to-speech
  engine the user selects.
- **Website content:** Yes — the extension reads the content of the page the
  user is on, only when the user triggers reading.
- **Data sold / transferred to third parties / used for unrelated purposes:**
  No to all.
- **Remote code:** None.
- **Privacy policy URL:** link the rendered PRIVACY.md (GitHub raw/pages or
  the repo blob URL).

## Review risk notes

- The `<all_urls>` content script (needed for the floating player) triggers
  slower review and a justification prompt. Justification: "The extension
  must extract article text and show a floating player on whatever page the
  user is reading; it activates only on user action."
- Review typically completes within a few days; can stretch to weeks.
- After approval you have 30 days to publish.

## Post-submission checklist

- [ ] Verify listing renders correctly in incognito preview
- [ ] Test the "installed from store" build end-to-end (not just unpacked)
- [ ] Mirror listing to Edge Add-ons (same Chromium package)
