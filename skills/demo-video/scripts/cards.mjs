// Render brand cards (intro, chapter, outro) as clips and lower-thirds as transparent PNGs.
// Usage: node cards.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ASSETS, BT709_TAGS, TO_BT709, args, die, ffmpeg, loadPlan, workDir } from './lib.mjs';

const a = args();
const outDir = path.resolve(a._[0] || die('usage: node cards.mjs <out-dir>'));
const { plan, fmt, brand } = loadPlan(outDir);
const dir = workDir(outDir, 'cards');
const portrait = fmt.height > fmt.width;
const long = plan.form === 'long';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const dataUri = (p) => p && `data:${MIME[path.extname(p).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(p).toString('base64')}`;
const identity = { name: brand.name, logo: dataUri(brand.logo), icon: dataUri(brand.icon) };
const { primary, deep, accent } = brand.colors;
const brandCss = `:root { --primary: ${primary}; --deep: ${deep}; --accent: ${accent}; }` +
  (brand.font ? `\n  @font-face { font-family: "BrandFont"; src: url("${pathToFileURL(brand.font).href}"); font-weight: 100 900; }` : '');
const template = fs.readFileSync(path.join(ASSETS, 'cards', 'card.html'), 'utf8').replace(/\/\* __BRAND_CSS__.*\*\//, brandCss);
const htmlFile = path.join(dir, 'card.html');
fs.writeFileSync(htmlFile, template);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: fmt.width, height: fmt.height } });

async function load(card) {
  await page.addInitScript((c) => { window.__CARD = c; }, card);
  await page.goto(pathToFileURL(htmlFile).href);
  await page.evaluate(() => document.fonts.ready);
}

async function clip(name, card) {
  await load({ ...card, ...identity, portrait });
  const frameDir = path.join(dir, name);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir);
  const n = Math.round(card.duration * plan.fps);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.render(t), i / plan.fps);
    await page.screenshot({ path: path.join(frameDir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
  }
  const file = path.join(dir, `${name}.mp4`);
  ffmpeg(['-framerate', String(plan.fps), '-i', path.join(frameDir, '%05d.jpg'), '-vf', TO_BT709, '-c:v', 'libx264', '-crf', '14', ...BT709_TAGS, file]);
  fs.rmSync(frameDir, { recursive: true, force: true });
  console.log(`${name}.mp4 (${card.duration}s)`);
  return { file: path.relative(outDir, file), duration: card.duration };
}

const manifest = { chapters: {}, lowerThirds: {} };
const intro = plan.intro || {};
manifest.intro = await clip('intro', { kind: 'intro', title: intro.title || plan.title || brand.name || '', sub: intro.sub, duration: intro.duration ?? (long ? 3.2 : 2.4) });

if (long && plan.chapterCards !== false) {
  const names = [...new Set(plan.shots.map((s) => s.chapter).filter(Boolean))];
  for (const [i, ch] of names.entries())
    manifest.chapters[ch] = await clip(`chapter-${i + 1}`, { kind: 'chapter', title: ch, num: String(i + 1).padStart(2, '0'), duration: 1.8 });
}

const outro = plan.outro || {};
// The brand's disclaimer shows when the VO matches its `when` pattern; plan.disclaimer true/false forces it.
const d = brand.disclaimer;
const showDisclaimer = !!d?.text && (plan.disclaimer ?? (d.when ? new RegExp(d.when, 'i').test(plan.shots.map((s) => s.vo || '').join(' ')) : true));
manifest.outro = await clip('outro', {
  kind: 'outro', title: outro.title, url: brand.url, tagline: brand.tagline,
  disclaimer: showDisclaimer ? d.text : null, duration: outro.duration ?? (long ? 4 : 3.2),
});

for (const s of plan.shots) {
  if (!s.lowerThird) continue;
  const lt = typeof s.lowerThird === 'string' ? { title: s.lowerThird } : s.lowerThird;
  await load({ kind: 'lower-third', ...lt, ...identity, portrait, duration: 1 });
  const file = path.join(dir, `lt-${s.id}.png`);
  await page.screenshot({ path: file, omitBackground: true });
  manifest.lowerThirds[s.id] = path.relative(outDir, file);
  console.log(`lt-${s.id}.png`);
}

await browser.close();
fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify(manifest, null, 2));
