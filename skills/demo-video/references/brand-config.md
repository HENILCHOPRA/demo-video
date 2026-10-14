# Brand config — `.demo-video/brand.json` + `brand.md`

Every project keeps its identity in `.demo-video/` at the repo root (commit it — it holds no secrets). The scripts read `brand.json`; you read `brand.md`. Both are optional: without them the video uses a neutral slate palette, the system sans font and a text wordmark.

## brand.json

All fields optional. Paths are relative to the repo root and checked at load (a missing file is an error, not a silent fallback).

```jsonc
{
  "name": "Acme",                         // text wordmark when there's no logo; intro title fallback
  "url": "acme.com",                      // public URL on the outro pill — never the app host
  "tagline": "Ship faster, together",     // tracked caps under the URL on the outro
  "colors": {
    "primary": "#1e293b",                 // card background, dips, cursor, caption box, lower-third bar — pick a DARK brand colour (white text sits on it)
    "deep": "#0f172a",                    // gradient end, darker than primary
    "accent": "#38bdf8"                   // thin rule + chapter number only
  },
  "font": "public/fonts/Brand.ttf",       // TTF/OTF for cards and burned captions (default: system sans / Arial)
  "fontFamily": "Brand",                  // only if auto-detection from the font file fails
  "logo": "public/logo-light.png",        // light/white wordmark that reads on `primary` (png, jpg, svg, webp)
  "icon": "public/icon-white.png",        // optional mark above the logo on the outro
  "locale": "en-US",                      // browser locale for the recording (dates, numbers)
  "timezone": "America/New_York",         // default: this machine's
  "disclaimer": {                         // optional small print on the outro
    "text": "AI output is reviewed by a human before use.",
    "when": "\\bAI\\b|agent|summar"       // shown when the VO matches (case-insensitive); omit `when` = always; plan.disclaimer true/false forces
  },
  "login": {                              // or `false` when the app needs no sign-in
    "path": "/login",                     // also how a redirect-to-login (expired session) is detected
    "email": "input[type=\"email\"]",
    "password": "input[type=\"password\"]",
    "submit": "button[type=\"submit\"]"
  },
  "envFiles": [".env", ".env.local"],     // where to look for OPENROUTER_API_KEY when it isn't in the environment
  "music": "assets/brand-bed.mp3"         // a licensed music bed; default: /brag's library if installed, else none
}
```

Login selectors are CSS (first match). For a username field use e.g. `"email": "input[name=\"username\"]"`. For OTP, magic links, SSO or captcha, keep `path` and use `record.mjs --login-headed` — the user signs in by hand once and the session (cookies + localStorage) is reused; apps that keep their token only in sessionStorage can't be resumed this way.

## Building one from the code

- **name** — `package.json` `name`/`productName`, `<title>`, the header component.
- **colors** — Tailwind `theme.extend.colors` (`primary`, `brand`), CSS custom properties (`--primary`, `--brand`), the header/sidebar background. If the brand colour is light, use a dark shade of it as `primary`.
- **font** — `@font-face` in global CSS, `public/fonts/`, `next/font/local` sources. Google-hosted only? Download the TTF into the repo or skip it.
- **logo / icon** — `public/`, `src/assets/`; prefer the variant used on dark backgrounds.
- **login** — the login route and its form inputs (look at the page component, not guesses).
- **url** — ask the user; never infer it from the dev/staging/app host.

Show the draft to the user before writing it.

## brand.md

Free text you follow while planning, writing VO, cards and share copy. Typical sections:

- **Public framing** — how the product describes itself; vendor/API names not to mention.
- **Approved claims** — the only numbers allowed on screen or in VO. Nothing else gets invented.
- **Banned phrases** and tone (formal/casual, audience).
- **URL rule** — the public URL vs. the app host that must never appear.
- **Pronunciations** — product name and domain words spelled for TTS (`"Acme" → "Ack-mee"`).
- **App quirks** — localStorage flags that suppress onboarding tours, floating widgets to `hide`, demo account notes.
