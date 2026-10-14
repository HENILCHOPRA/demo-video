# demo-video — a Claude Code plugin

Ask Claude for a demo of your app and get a finished, narrated product video. It isn't a mock-up: Claude records your **real app** in a browser and edits the footage.

> "Make a 45s LinkedIn demo of our task board — creating a task and seeing it land on the board."

Claude reads your code to find the routes, labels and flow, then writes a storyboard and waits for your OK. After that it:

- generates the voiceover with ElevenLabs via OpenRouter, plus word-timed captions,
- drives your app with Playwright while screen-recording,
- edits the result: cuts loading dead time, syncs actions to the voice, eases the camera in on what's clicked or typed, adds UI sound effects, ducked music and your brand's intro and outro cards.

It supports short social clips (30–75s, 16:9 or 9:16) and long chaptered walkthroughs (2–6 min).

## Install

```
/plugin marketplace add HENILCHOPRA/demo-video
/plugin install demo-video@demo-video
```

Then, in your app's repo, ask for a demo video or run `/demo-video`.

### Prerequisites

| | |
|---|---|
| Node.js 18+ | the scripts' first run does `npm install` and `npx playwright install chromium` |
| ffmpeg + ffprobe | on `PATH` (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`) |
| `OPENROUTER_API_KEY` | in the environment or a `.env` file in your repo (used for TTS + transcription) |
| A running app + demo account | local dev server or staging; use synthetic data, as the recorder really clicks |

## Make it look like your brand

Add `.demo-video/brand.json` to your repo and commit it. If you skip this, Claude drafts the file from your code the first time and asks you to confirm it.

```json
{
  "name": "Acme",
  "url": "acme.com",
  "tagline": "Ship faster, together",
  "colors": { "primary": "#1e293b", "deep": "#0f172a", "accent": "#38bdf8" },
  "font": "public/fonts/Inter.ttf",
  "logo": "public/logo-white.png",
  "login": { "path": "/login", "email": "input[name=email]", "password": "input[name=password]", "submit": "button[type=submit]" }
}
```

Next to it, `.demo-video/brand.md` holds rules Claude follows while writing: tone, approved claims, phrases to avoid, pronunciations, and onboarding popups to suppress. The full schema is in [skills/demo-video/references/brand-config.md](skills/demo-video/references/brand-config.md).

## Sign-in

- **Email + password**: Claude passes these as env vars (`DEMO_EMAIL`, `DEMO_PASSWORD`) and never writes them to disk.
- **OTP / SSO / captcha**: a browser window opens once, you sign in by hand and close it, and the session is reused (`record.mjs --login-headed`).
- **No auth**: set `"login": false`.

The login screen never appears in the footage.

## Output

```
demo-output/
  demo.mp4          final video (poster baked as frame 0)
  demo.jpg          thumbnail
  captions/demo.srt
  chapters.txt      long-form: YouTube timestamps
  share-copy.txt
  demo-plan.md      storyboard
  shots.json        machine plan (edit and re-run any step)
  work/             intermediates (VO, raw take, cards)
```

Add `demo-output*/` to your `.gitignore`. Claude does this on the first run.

## Pipeline

```
voice.mjs → record.mjs --rehearse → record.mjs → cards.mjs → edit.mjs → poster.mjs
```

Every step is cached or re-runnable, so changing one voice line doesn't mean re-recording. See [SKILL.md](skills/demo-video/SKILL.md) and `references/` for details.

## License

MIT. Sound effects are CC0; see [CREDITS.md](CREDITS.md).
