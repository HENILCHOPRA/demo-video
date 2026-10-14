# Editing

`cards.mjs <out-dir>` then `edit.mjs <out-dir> [--draft] [--no-music] [--no-sfx] [--music file.mp3]`.

## Timeline

```
[intro card] → ([chapter card] → shot … )… → [outro card]
```
Cards are solid brand `primary`, so shots fade in from / out to that colour (0.3s) next to a card; consecutive shots hard-cut — the footage is continuous, so the cut reads as an edit, not a jump.

## Per-shot fit (the "remove unnecessary delay" step)

1. Kept ranges = shot window minus logged waits (loading/settling).
2. Target length `T = VO + 0.35s lead + 0.6s tail`.
3. If visuals are > T + 0.4s, speed up uniformly to at most **1.25×** (UI motion still looks natural; beyond that, cursor glides look frantic). Still long → warning: shorten actions or lengthen the VO line.
4. If visuals are shorter, the last frame holds (`tpad` clone) — the recorder dwell makes this rare.
5. VO always starts 0.35s into its shot and is never time-stretched.

## Zoom grammar

Implemented with `zoompan` on the 2× take, with smoothstep easing on zoom and centre.

- For each event with `zoom: true` (and every `focus`): target scale makes the element fill ~42% of the frame (72% for `focus`/`drag`), clamped to `[1, maxZoom]`; under 1.15× it stays wide.
- Push in starts 0.6s before the action, takes 0.55s, so the camera has arrived when the click lands.
- Hold until 0.9s after the action (or after typing ends), then ease out over 0.6s.
- If the next zoom target comes within ~0.6s of releasing, the camera pans straight there instead of breathing out and back in.
- Centre is clamped so the frame never shows outside the page.

Tuning: lower `maxZoom` if text gets soft; set `zoom: false` on actions where context matters more than detail; add a `focus` to push in on a result.

## Overlays

- **Lower-third**: white card, `primary` bar and title, bottom-left (top on vertical, clear of captions); fades in at 0.5s, holds ≥3.2s.
- **Captions**: brand font (Arial without one), white on a `primary` box, bottom-centre; vertical sits higher to clear platform UI. Cues break on punctuation, pauses > 0.5s, or the word cap (4 short / 8 long), min 0.7s on screen.
- **Cards**: intro (logo or text wordmark, `accent` rule, title, tracked-caps sub), chapter (`accent` number + title), outro (icon, logo, optional headline, public-URL pill, tagline, disclaimer). All from brand.json; anything unset is left out. Template: `assets/cards/card.html`, rendered frame-by-frame from a pure `render(t)`.

## Mix

| Layer | Level | Treatment |
|---|---|---|
| VO | 1.0 | starts 0.35s into each shot |
| Music bed | 0.3 (`musicVolume`) | fade in 1.2s, out 2.5s; side-chain ducked under VO (ratio 9, release 450ms) |
| Clicks | 0.55 | at the press, `interface/click_003` (mobile `ui/click2`) |
| Typing | 0.16 | every other character, rotated keypress samples |
| Lower-third in | 0.32 | `interface/drop_001` |
| Intro / chapter / outro | 0.55 / 0.45 / 0.38 | soft impact on title land, bell on outro |

Final pass: `loudnorm` to −14 LUFS / −1.5 dBTP (social platform target), AAC 192k, H.264 CRF 18, faststart.

Colour: every encode (take, cards, shots, final, poster) converts to limited-range BT.709 `yuv420p` and tags it so. The screencast and card frames are full-range BT.601 JPEGs; left that way (`yuvj420p`, range `pc`) the video looks washed out in many players and after platform re-encodes. Check with `ffprobe -show_entries stream=pix_fmt,color_range,color_space demo.mp4` → `yuv420p`, `tv`, `bt709`.

Captions sidecar: when captions are burned (`burn`/`both`) the `.srt` goes to `captions/<base>.srt`, because players auto-load a same-named `.srt` next to the video and would show every caption twice.

## QA stills

```bash
ffmpeg -ss <t> -i demo.mp4 -frames:v 1 -vf scale=960:-1 still_<t>.png
```
Use `work/edit/timeline.json` for segment offsets. Check each shot's zoom hold, card settled frames, and a frame 0.15s into each colour dip.

## Re-cutting without re-recording

Most fixes don't need a new take: change VO text → `voice.mjs --only sX` → `edit.mjs`. But VO length changes shift the dwell the recorder used; if a shot's new VO is much longer it just holds the last frame — fine up to ~1s, otherwise re-record.
