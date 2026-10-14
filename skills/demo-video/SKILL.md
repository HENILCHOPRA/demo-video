---
name: demo-video
description: Make narrated product demo videos of the user's own web app — short-form (30–75s social clips, 16:9 or 9:16) or long-form (2–6 min chaptered walkthroughs) — by reading the app's code, storyboarding, generating an ElevenLabs voiceover + captions via OpenRouter, driving the real app with Playwright while screen-recording, then editing (dead-time cuts, VO sync, auto-zoom on actions, SFX, ducked music, branded intro/outro cards). Use whenever someone asks for a product demo, feature walkthrough, explainer, screen recording, tutorial video, onboarding video, "show how X works" video, a reel/short for LinkedIn/YouTube/Instagram, or says /demo-video — even if they don't say "video" explicitly but want their app shown in action. For 15–25s hype teasers without a real recording, /brag fits better.
---

# Demo video

You turn a feature (or the whole product) into a demo that looks like a polished product-marketing video: real app footage, a calm confident voice, tight cuts, the camera pushing in on what matters, the product's own brand at both ends.

It follows /brag's philosophy — the plan is the contract, the hook is everything, show the real thing, readable over fast, sound supports motion and never calls attention to itself — but where brag *recreates* UI, this skill *records the real app* and lets the voiceover set the pace.

`<skill-dir>` is this file's directory; scripts live in `<skill-dir>/scripts/` (Node 18+ ESM, Playwright, ffmpeg/ffprobe on PATH). Run `npm install` there once if `node_modules/` is missing, and `npx playwright install chromium` if Chromium is missing. Run every script from inside the app's repo (or set `DEMO_PROJECT_ROOT`) — that's where the brand config and asset paths resolve.

## Pipeline at a glance

```
intake + brand → inspect code → demo-plan.md + shots.json → [user OK]
  → voice.mjs (TTS + word timings) → record.mjs --rehearse → record.mjs (take)
  → cards.mjs → edit.mjs → QA stills → poster.mjs → share copy
```

Output goes to `demo-output/` in the repo root (`demo-output-YYYY-MM-DD-HHmmss/` if that exists). Everything intermediate lives in its `work/`. Make sure `demo-output*/` is in the repo's `.gitignore` before the first run — add it if not (it can hold a saved login session).

## 1. Intake and brand

**Brand.** Read `.demo-video/brand.json` and `.demo-video/brand.md` at the repo root if they exist — they hold the product name, public URL, colours, font, logos, locale, login selectors, disclaimer and the copy rules (public framing, approved claims, banned phrases, pronunciations). Follow `brand.md` as you would the user. If there is no `brand.json`, build one with the user: infer what you can from the code (product name from `package.json`/title tag, logo and font files under `public/`/`assets/`, primary colour from the Tailwind config or CSS variables, login route and its input selectors), show it, ask only for what's missing (public URL to put on the outro), then write it. Schema and defaults: [references/brand-config.md](references/brand-config.md).

**Request.** Collect, asking only for what the user hasn't said:

| Item | Default |
|---|---|
| Scope — whole product or which features | ask |
| Form — `short` (30–75s) or `long` (2–6 min) | short |
| Format — `landscape` 1920×1080, `vertical` 1080×1920, or both | landscape (short for Reels/Shorts → vertical) |
| Base URL of the app to record | ask every run |
| How to sign in — demo email + password, or a hand sign-in (`--login-headed`) for OTP/SSO apps, or none | ask every run |
| Voice (`brian`, `george`, `sarah`, `alice`, `daniel`, `charlie`, … 21 total) | `brian` |
| Audience / where it'll be posted | infer |

Credentials and base URL are passed to scripts only as env vars `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_BASE_URL`. Never write them into the plan, shots.json, logs, or the summary. The recorder signs in *before* recording starts, so the login screen never appears in footage.

The recorder really clicks things in that account. Prefer read-and-navigate flows; when a flow must create data, use plausible demo-looking names, tell the user what will be created, and mention cleanup at the end. Never record against a real customer's account.

"Both formats" means two takes (the mobile layout differs) — plan once, write a `shots.json` per format if locators differ, run the pipeline twice into the same output folder (`plan.output` distinguishes `demo` / `demo-vertical`).

## 2. Inspect the code

The app is right here, so read it rather than guessing:

1. Find the routes: React Router `<Route path=…>` / `createBrowserRouter`, Next.js `app/**/page.tsx` or `pages/`, Remix/SvelteKit `routes/`, Vue Router `routes: […]`, Angular `Routes`, or server templates (Rails `routes.rb`, Django `urls.py`, Laravel `routes/web.php`). Follow each feature in scope to its page component and children.
2. Pull **verbatim** visible strings — button labels, headings, tab names, placeholders, empty-state copy. They become locators (`{ "role": "button", "name": "New Task" }`, `{ "placeholder": "Search" }`). Use `data-testid`s via `css` when the app has them; prefer placeholder/role/text over `label` when `<label>`s aren't associated with inputs.
3. Find the **flow**: entry → key action → visible result. A demo that shows the product *doing* something beats a tour of screens.
4. Note conditional UI (feature flags, plan gating, first-run modals, What's-new popups, cookie banners) — add `optional: true` dismiss actions in `setup`, or seed the flags the app checks via the plan's `localStorage`.

## 3. Plan — `demo-plan.md` + `shots.json`

Read [references/storyboard.md](references/storyboard.md) for the templates, pacing tables, VO writing rules and the full `shots.json` schema.

- `demo-plan.md` is for humans: the angle, hook, who it's for, chapter/shot table with VO lines, on-screen action, zoom targets, lower-thirds and audio intent.
- `shots.json` is the machine contract the scripts read: per shot a `vo` line and `actions[]` with locators, `zoom` hints and optional `cue` phrases that sync an action to a word in the VO.

**Gate — show the storyboard (shot list + VO lines) to the user and get a go-ahead before generating audio.** Voice and recording are the expensive steps; a two-line change now saves a re-take.

## 4. Voice

```bash
node <skill-dir>/scripts/voice.mjs <out-dir>
```

Per shot: `elevenlabs/eleven-v4` TTS → silence-trimmed mp3; then `elevenlabs/scribe-v2` transcription → word timestamps in `work/vo/timing.json`, plus a script-vs-transcript match score. Key: `OPENROUTER_API_KEY` from env, else the `.env` files listed in `brand.envFiles`. Cached by text+voice, so editing one line and re-running only regenerates that shot (`--only s3 --force` to force one).

Listen-check: any shot flagged under 85% match (a mispronounced product name or domain term, a skipped word) — rephrase or spell phonetically in `vo`, re-run that shot. See [references/audio.md](references/audio.md) for voice and pronunciation tips; brand-specific pronunciations live in `brand.md`.

## 5. Rehearse, then record

```bash
DEMO_BASE_URL=… DEMO_EMAIL=… DEMO_PASSWORD=… node <skill-dir>/scripts/record.mjs <out-dir> --rehearse
DEMO_BASE_URL=… DEMO_EMAIL=… DEMO_PASSWORD=… node <skill-dir>/scripts/record.mjs <out-dir>
```

OTP / SSO / captcha logins: run `DEMO_BASE_URL=… node <skill-dir>/scripts/record.mjs <out-dir> --rehearse --login-headed` once — a browser window opens, the user signs in by hand and closes it, and the session is saved to `work/auth-state.json` and reused by later runs. Apps without sign-in set `"login": false` in `brand.json`.

Rehearsal runs every action fast with no recording and stops at the first locator that fails, printing a screenshot path and the visible controls on that screen — fix the locator from that list and re-run until it prints `REHEARSAL OK`. Then the take: CDP screencast at 2× device pixels (crisp zooms), brand-coloured cursor with click ripple, actions paced against each shot's VO length and `cue` words, every action logged with its on-screen box, every loading wait logged as cuttable. Details and the action vocabulary: [references/recording.md](references/recording.md).

A rehearsal executes the clicks too — except actions marked `commit: true`, which it only checks are present. Mark every data-changing step (Save, Submit, Post, Delete) and the waits that depend on it, so the record is created once, in the take. Hide floating widgets (chat buttons, banners) with `hide` selectors.

## 6. Edit

```bash
node <skill-dir>/scripts/cards.mjs <out-dir>
node <skill-dir>/scripts/edit.mjs <out-dir> [--draft]
```

`cards.mjs` renders the brand intro, chapter cards (long-form), outro (logo, public URL, tagline, the brand's disclaimer when the VO matches its trigger) and lower-third overlays. `edit.mjs` cuts loading dead time, fits each shot to its VO (speed-up capped at 1.25×, freeze-hold when short), eases the camera in on clicked/typed/focused elements and back out, dips through the brand colour around cards, lays SFX on clicks/typing/reveals, ducks the music bed under the voice, burns or side-cars captions and normalizes to −14 LUFS. Use `--draft` while iterating. How the edit decisions are made and how to tune them: [references/editing.md](references/editing.md).

## 7. QA and deliver

1. Pull stills — every shot mid-way, every zoom at its hold, every card settled, two mid-transition frames — and look at them. Check: zoom framed on the right thing, no clipped caption, nothing sensitive on screen (real names, phone numbers, emails other than demo data — add `mask` selectors and re-take if so), the app's own host never visible (only the public URL from brand.json), end card correct.
2. Watch the warnings `edit.mjs` printed (visuals running long past VO, etc.) and fix in `shots.json` → re-record only if needed; most fixes are VO wording or a `pause`.
3. Final render without `--draft`, then `node <skill-dir>/scripts/poster.mjs <out-dir> [--at s]` — default poster is the settled outro; pass `--at` for a stronger product frame. It is baked in as frame 0 so every platform thumbnails it.
4. Write `share-copy.txt` (1–3 sentences, specific, no "excited to share", following brand.md). Long-form also gets `chapters.txt` (YouTube timestamps, written by edit.mjs).
5. Tell the user: where the files are, duration, one sentence on the angle, anything created in their demo account, and offer to re-cut a shot, change voice, or produce the other format.

## Creative laws

- **Hook in 3 seconds.** Short-form opens on the outcome or the pain, not the logo — the intro card is 2.4s and carries the hook line. Long-form may open with a 1-line promise of what they'll be able to do.
- **Show the product doing the job.** Real footage of the flow, not screens in a row. One idea per shot.
- **The voice sets the pace.** Write the VO first, act to it. Visuals never run silently for more than ~1s except a deliberate beat.
- **Narrate the why, show the what.** VO shouldn't read the button labels aloud ("click the New Task button") — say what the user gets ("Add a task right from the project"); the zoom and cursor show the how.
- **Camera with intent.** Zoom in for small targets and typed text, stay wide for layout and boards. Never more than one zoom move per ~1.5s; no zoom during scroll.
- **Readable.** Captions short (≤4 words a cue short-form), on-screen text held long enough to read (~0.3s/word).
- **Specific and on-brand.** The product's own copy and claims from brand.md only — never invent numbers or testimonials; no generic SaaS phrases ("streamline your workflow" is banned); brand colours and font; the public URL, never the app host.
- **Sound is a mix, not a soundboard.** Soft clicks under the voice, one payoff accent, music low and ducked. Fewer, better cues.
