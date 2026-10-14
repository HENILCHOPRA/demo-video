# Audio

## Voice (OpenRouter → ElevenLabs)

- TTS: `POST https://openrouter.ai/api/v1/audio/speech` — `{ model: "elevenlabs/eleven-v4", input, voice, response_format: "mp3" }` → raw audio bytes. 10,000 char limit per request (we send one shot at a time).
- STT: `POST https://openrouter.ai/api/v1/audio/transcriptions` — `{ model: "elevenlabs/scribe-v2", input_audio: { data: <base64>, format: "mp3" }, response_format: "verbose_json", timestamp_granularities: ["word","segment"] }`. If no word timestamps come back, voice.mjs estimates them from the script (`wordsSource: "estimated"`) — captions still work, cue sync is approximate.
- Auth: `OPENROUTER_API_KEY` (env, else the `.env` files in `brand.envFiles`). Never print it.
- Voices (21): george, sarah, adam, alice, bella, bill, brian, callum, charlie, chris, daniel, eric, harry, jessica, laura, liam, lily, matilda, river, roger, will. Defaults: **brian** (warm, confident) for product demos; **george** for long-form calm; **alice** / **sarah** for a female narrator. Keep one voice per video.

## Pronunciation

eleven-v4 handles most vocabulary, but check the match score and listen to:
- Product and brand names — spell them as they sound ("Acme" → "Ack-mee") if they come out wrong; keep a list in brand.md.
- Acronyms → letters with hyphens ("API" → "A-P-I") unless said as a word · currency → write it out ("25,000 dollars") · dates → "14th October".
- Domain jargon and non-English terms → phonetic spelling; record what worked in brand.md so the next video gets it right.
Write the phonetic form in `vo`; captions come from the transcript, so if phonetic spelling leaks into captions, fix the caption text in `work/vo/timing.json` words before editing.

## SFX library

Curated CC0 subset (Kenney + unicae_games keyboard pack) copied from /brag, all low/medium high-frequency risk per brag's `sfx-analysis`:

| File | Use |
|---|---|
| `interface/click_002/003/005`, `ui/click2`, `ui/mouseclick1` | clicks, key presses (mobile taps use `ui/click2`) |
| `keyboard/keypress-*.wav` (12) | typing, rotated |
| `interface/drop_001/002` | lower-third / toast / soft element landing |
| `interface/select_008`, `interface/switch_002`, `ui/rollover2` | selection, toggles, subtle hover |
| `casino/card-slide-1` | drag / card moving between columns |
| `impact/impactSoft_medium_001/002/004` | intro title, chapter card, major reveal |
| `impact/impactBell_heavy_000/003` | outro / one success payoff per video |
| `interface/bong_001` | soft single accent |

Rules from brag that apply: align SFX to the *start* of the motion (clicks at press, reveals at landing); repeated sounds stay quiet; one announcement-style accent per video; when unsure, fewer cues.

## Music

Brag's "Happy Beats / Business Moves" tracks are read from the installed brag plugin (`~/.claude/plugins/cache/brag/brag/<ver>/skills/brag/assets/music/`), not copied here — their license isn't documented for redistribution. Defaults: **vol-11** (warm, business-y) for short, **vol-12** (steady, clean) for long. `music: "none"` for silent beds; `--music file.mp3` for a custom licensed track. If brag isn't installed the video renders without music and edit.mjs warns.
