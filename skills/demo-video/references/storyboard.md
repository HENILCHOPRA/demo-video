# Storyboard, VO and shots.json

## Shapes

**Short-form (30–75s)** — one feature or one flow. 4–8 shots.
```
Intro card with hook line (2.4s) → Problem/setup shot (1 line) → 2–4 action shots → Payoff shot (the result) → Outro card (3.2s)
```

**Long-form (2–6 min)** — the product or a set of features, chaptered.
```
Intro card (3.2s) → Overview shot (what you'll see) → Chapter → 3–8 shots each … → Recap shot → Outro card (4s)
```
Each chapter is one job-to-be-done ("Bring a case in", "Plan the week's work", "Draft with AI"), 20–60s, and gets a chapter card automatically (`chapterCards: false` to disable).

## Pacing

| | Short | Long |
|---|---|---|
| VO per shot | 1 sentence, 6–16 words (≈2.5–6s) | 1–2 sentences, ≤30 words (≈4–11s) |
| Actions per shot | 1–2 | 1–4 |
| Words per minute | ~160 (energetic) | ~145 (calm) |
| Lower-thirds | 0–2 (feature names) | first shot of each chapter |
| Captions | burned, ≤4 words a cue (upload sidecar in `captions/`) | `.srt` sidecar (`"captions": "both"` to also burn; sidecar then moves to `captions/`) |

Count it: total ≈ sum of VO durations + 0.95s per shot + cards. Estimate VO at 2.6 words/s before generating.

## Writing the voiceover

- Second person, present tense, in the register brand.md sets for the audience: "You", "your projects", "your team". Precise, never cute.
- Lead with the outcome, then the action: "Every deadline for the week, in one place — just open Calendar."
- Don't narrate UI mechanics ("now I click the blue button"). The cursor and zoom show that.
- One idea per line. Lines that end on the key noun land better on a cut.
- Use the product's terms exactly as they appear in the UI. Spell tricky words so TTS says them right — see audio.md and brand.md.
- eleven-v4 supports inline delivery tags like `[warmly]`, `[confident]`, `[short pause]` — use sparingly (≤1 per shot); they're stripped from captions.
- Never invent numbers, testimonials or claims. Only the figures approved in brand.md.

## Choosing zoom targets

- `zoom: true` on: small buttons, form fields being typed in, a result row/badge that just appeared, a toast.
- Leave wide: boards, dashboards, page transitions, scrolling, drag across columns (use `focus` with a container target for a gentle push-in instead).
- Use a `focus` action (no interaction) to push in on the result after an action: "the new task, now on the board".

## demo-plan.md template

```markdown
# Demo plan: <title>
Form: short | long · Format: landscape | vertical · Target: <s> · Voice: <id>
Audience / channel: <who, where>

## Angle
<one paragraph: the job this shows, why the viewer cares, the hook>

## Hook
<intro card line + first VO line>

## Shots
| # | Chapter | VO | On screen / actions | Zoom | Overlay | Audio |
|---|---|---|---|---|---|---|
| s1 | — | "…" | open /tasks, board settles | wide | LT "Tasks" | drop on LT |

## Payoff & outro
<final line; outro headline>

## Data created in the demo account
<none | list>

## Share copy (draft)
<1–3 sentences>
```

## shots.json schema

```jsonc
{
  "title": "Tasks, sorted",            // fallback intro title
  "form": "short",                      // short | long
  "format": "landscape",                // landscape | vertical
  "voice": "brian",
  "captions": "burn",                   // burn | sidecar | both   (default: short→burn, long→sidecar)
  "music": "auto",                      // auto | none | vol-1 | vol-9 | vol-10 | vol-11 | vol-12 | <path.mp3>
  "musicVolume": 0.3,
  "sfx": true,
  "maxZoom": 1.8,                       // default 1.8 landscape, 1.45 vertical
  "mask": [".client-phone", "[data-pii]"],   // CSS selectors blurred in every frame
  "hide": [".chat-widget-launcher", ".promo-banner"],  // CSS selectors removed from every frame
  "localStorage": { "onboarding": { "hasSeenWelcome": true, "hasCompletedTour": true } },  // seeded before the app loads (fresh profile each run)
  "output": "demo",                     // file stem; default demo / demo-vertical
  "disclaimer": true,                   // force brand.disclaimer on/off; default: its `when` pattern vs. the VO
  "intro": { "title": "Every task. One board.", "sub": "Acme Tasks", "duration": 2.4 },
  "outro": { "title": "Run your practice, not your inbox" },
  "setup": [                            // runs after login, before recording; dismiss popups etc.
    { "do": "click", "target": { "role": "button", "name": "Got it" }, "optional": true }
  ],
  "shots": [
    {
      "id": "s1",
      "chapter": "Plan the week",       // long-form chapter grouping
      "goto": "/tasks",                 // navigate at shot start (loading is cut)
      "vo": "Every project's work, on one board.",
      "lowerThird": { "title": "Tasks", "sub": "Across all your projects" },  // or a plain string
      "hold": 3,                        // seconds, only used when the shot has no VO
      "actions": [
        { "do": "focus", "target": { "css": "[class*=kanban]" }, "ms": 1400 },
        { "do": "click", "target": { "role": "button", "name": "New Task" }, "zoom": true, "cue": "add" },
        { "do": "type", "target": { "placeholder": "Task title" }, "text": "Send launch brief — Q3 campaign", "zoom": true },
        { "do": "press", "key": "Enter", "commit": true },   // creates data → skipped in rehearsal
        { "do": "wait", "for": { "text": "Send launch brief" }, "commit": true }
      ]
    }
  ]
}
```

Targets: `{role,name}` · `{text}` · `{placeholder}` · `{label}` · `{title}` · `{css}`; modifiers `exact`, `nth`, `hasText`, `within: <target>`, `visible: false` (match hidden elements too). Action vocabulary and timing semantics: recording.md.
