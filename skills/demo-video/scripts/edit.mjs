// Edit the take into the final demo: cut dead time, fit each shot to its VO, auto-zoom on actions,
// brand cards + lower-thirds, SFX, ducked music, captions, loudness.
// Usage: node edit.mjs <out-dir> [--no-music] [--no-sfx] [--music <file>] [--draft]
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS, BT709_TAGS, TO_BT709, args, assColor, bragMusicDir, clamp, die, duration, ffColor, ffmpeg, loadPlan, r3, run, workDir } from './lib.mjs';

const VO_LEAD = 0.35, SHOT_TAIL = 0.6, MAX_SPEED = 1.25;
const a = args();
const outDir = path.resolve(a._[0] || die('usage: node edit.mjs <out-dir>'));
const { plan, fmt, brand } = loadPlan(outDir);
const DIP = ffColor(brand.colors.primary);  // shots dip through the card colour next to a card
const W = fmt.width, H = fmt.height, FPS = plan.fps;
const work = workDir(outDir);
const editDir = workDir(outDir, 'edit');
const read = (p) => JSON.parse(fs.readFileSync(path.join(outDir, p), 'utf8'));
const take = read('work/take/events.json');
const timing = fs.existsSync(path.join(outDir, 'work/vo/timing.json')) ? read('work/vo/timing.json').shots : {};
const cards = read('work/cards/cards.json');
const takeMp4 = path.join(outDir, 'work/take/take.mp4');
const maxZoom = plan.maxZoom ?? (fmt.mobile ? 1.45 : 1.8);
const frame = (t) => Math.round(t * FPS) / FPS;

// ---------- 1. per-shot cut lists, retime, zoom ----------
const shotOut = [];
for (const [i, s] of take.shots.entries()) {
  const def = plan.shots.find((p) => p.id === s.id) || {};
  let ranges = [[s.start, s.end]];
  for (const w of take.waits.filter((w) => w.shot === s.id)) {
    ranges = ranges.flatMap(([a0, b0]) => (w.end <= a0 || w.start >= b0) ? [[a0, b0]]
      : [[a0, w.start], [w.end, b0]].filter(([x, y]) => y - x > 1 / FPS));
  }
  const V = ranges.reduce((sum, [x, y]) => sum + y - x, 0);
  const vo = timing[s.id];
  const T = vo ? vo.duration + VO_LEAD + SHOT_TAIL : V;
  let speed = 1;
  if (V > T + 0.4) speed = Math.min(MAX_SPEED, V / T);
  const dur = frame(Math.max(V / speed, T));
  if (V / speed > T + 0.4) console.warn(`  ⚠ ${s.id}: visuals run ${r3(V / speed - T)}s past the VO even at ${speed}× — tighten actions or lengthen the line`);
  const map = (t) => {
    let acc = 0;
    for (const [x, y] of ranges) {
      if (t < x) return acc / speed;
      if (t <= y) return (acc + t - x) / speed;
      acc += y - x;
    }
    return acc / speed;
  };
  const evs = take.events.filter((e) => e.shot === s.id).map((e) => ({ ...e, lt: map(e.t), ltEnd: map(e.tEnd ?? e.t) }));
  shotOut.push({ id: s.id, def, ranges, speed, dur, evs, vo });
}

function zoomKeys(evs, dur) {
  const K = [{ t: 0, z: 1, x: 0.5, y: 0.5 }];
  const push = (k) => { if (k.t > K.at(-1).t + 0.02) K.push(k); };
  const zs = evs.filter((e) => e.zoom && e.bbox);
  zs.forEach((e, k) => {
    const bw = e.bbox.w / take.viewport.width, bh = e.bbox.h / take.viewport.height;
    const fill = e.type === 'focus' || e.type === 'drag' ? 0.72 : 0.42;  // share of frame the target should occupy
    const z = clamp(Math.min(fill / Math.max(bw, 0.01), fill / Math.max(bh, 0.01)), 1, maxZoom);
    if (z < 1.15) return;
    const cx = clamp(e.bbox.cx / take.viewport.width, 0.5 / z, 1 - 0.5 / z);
    const cy = clamp(e.bbox.cy / take.viewport.height, 0.5 / z, 1 - 0.5 / z);
    const inAt = Math.max(e.lt - 0.6, K.at(-1).t);
    const prev = K.at(-1);
    push({ ...prev, t: inAt });
    push({ t: Math.min(inAt + 0.55, dur), z, x: cx, y: cy });
    const holdEnd = Math.max(e.ltEnd, e.lt) + 0.9;
    const next = zs[k + 1];
    if (next && next.lt - 0.6 < holdEnd + 0.6) return; // pan straight to the next target
    push({ t: Math.min(holdEnd, dur), z, x: cx, y: cy });
    push({ t: Math.min(holdEnd + 0.6, dur), z: 1, x: 0.5, y: 0.5 });
  });
  return K;
}

function expr(K, key) {
  let e = String(r3(K.at(-1)[key]));
  for (let i = K.length - 2; i >= 0; i--) {
    const p = K[i], q = K[i + 1], dv = q[key] - p[key];
    const seg = Math.abs(dv) < 1e-4 ? `${r3(p[key])}`
      : `st(0,clip((it-${r3(p.t)})/${r3(q.t - p.t)},0,1));${r3(p[key])}+${r3(dv)}*ld(0)*ld(0)*(3-2*ld(0))`;
    e = `if(lt(it,${r3(q.t)}),${seg},${e})`;
  }
  return e;
}

// Segment order: intro, [chapter card], shots…, outro.
const segments = [{ kind: 'card', name: 'intro', ...cards.intro }];
let lastChapter = null;
for (const s of shotOut) {
  const ch = s.def.chapter;
  if (ch && ch !== lastChapter && cards.chapters[ch]) segments.push({ kind: 'card', name: `chapter:${ch}`, ...cards.chapters[ch] });
  lastChapter = ch ?? lastChapter;
  segments.push({ kind: 'shot', ...s });
}
segments.push({ kind: 'card', name: 'outro', ...cards.outro });

const takeDims = run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', takeMp4]).trim();
console.log(`take ${takeDims} → ${W}x${H} @${FPS}fps`);

for (const [k, seg] of segments.entries()) {
  if (seg.kind !== 'shot') continue;
  const K = zoomKeys(seg.evs, seg.dur);
  const fadeIn = segments[k - 1]?.kind === 'card', fadeOut = segments[k + 1]?.kind === 'card';
  const trims = seg.ranges.map(([x, y], j) => `[0:v]trim=${r3(x)}:${r3(y)},setpts=PTS-STARTPTS[r${j}]`);
  const cat = seg.ranges.length > 1 ? `${seg.ranges.map((_, j) => `[r${j}]`).join('')}concat=n=${seg.ranges.length}:v=1:a=0[cat]` : `[r0]null[cat]`;
  let chain = `[cat]setpts=PTS/${seg.speed},fps=${FPS},zoompan=z='${expr(K, 'z')}':x='max(0,min(iw-iw/zoom,(${expr(K, 'x')})*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${expr(K, 'y')})*ih-ih/zoom/2))':d=1:s=${W}x${H}:fps=${FPS},tpad=stop_mode=clone:stop_duration=${seg.dur},trim=duration=${seg.dur},setsar=1,${TO_BT709}`;
  const inputs = ['-i', takeMp4];
  const lt = cards.lowerThirds[seg.id];
  if (lt) {
    const on = 0.5, off = clamp(Math.min(seg.dur - 0.6, on + Math.max(3.2, seg.dur * 0.5)), on + 1, seg.dur);
    seg.ltAt = on;
    inputs.push('-loop', '1', '-t', String(seg.dur), '-i', path.join(outDir, lt));
    chain += `[base];[1:v]format=rgba,fade=t=in:st=${on}:d=0.3:alpha=1,fade=t=out:st=${r3(off - 0.3)}:d=0.3:alpha=1,scale=out_range=tv:out_color_matrix=bt709,format=yuva420p[lt];[base][lt]overlay=0:0:shortest=1`;
  }
  if (fadeIn) chain += `,fade=t=in:st=0:d=0.3:color=${DIP}`;
  if (fadeOut) chain += `,fade=t=out:st=${r3(seg.dur - 0.3)}:d=0.3:color=${DIP}`;
  chain += `,${TO_BT709}[v]`;
  const graphFile = path.join(editDir, `${seg.id}.filter`);
  fs.writeFileSync(graphFile, [...trims, cat, chain].join(';\n'));
  seg.file = path.join(editDir, `${seg.id}.mp4`);
  ffmpeg([...inputs, '-/filter_complex', graphFile, '-map', '[v]', '-c:v', 'libx264', '-preset', a.draft ? 'ultrafast' : 'medium', '-crf', '14', ...BT709_TAGS, seg.file]);
  console.log(`${seg.id}: ${seg.ranges.length} range(s), ${seg.speed === 1 ? '1×' : `${r3(seg.speed)}×`}, ${seg.dur}s, ${K.length - 1} zoom keys${lt ? ', lower-third' : ''}`);
}

// ---------- 2. timeline ----------
let t = 0;
for (const seg of segments) {
  seg.offset = r3(t);
  seg.path = seg.kind === 'shot' ? seg.file : path.join(outDir, seg.file);
  seg.len = seg.kind === 'shot' ? seg.dur : r3(duration(seg.path));
  t += seg.len;
}
const TOTAL = r3(t);
fs.writeFileSync(path.join(editDir, 'concat.txt'), segments.map((s) => `file '${s.path.replace(/\\/g, '/')}'`).join('\n'));

// ---------- 3. audio ----------
const audioIn = [];      // ffmpeg input args
const graph = [];
let idx = 1;             // input 0 is the concat video
const voLabels = [];
for (const seg of segments) {
  if (seg.kind !== 'shot' || !seg.vo) continue;
  audioIn.push('-i', path.join(outDir, seg.vo.file));
  graph.push(`[${idx}:a]adelay=${Math.round((seg.offset + VO_LEAD) * 1000)}:all=1[vo${idx}]`);
  voLabels.push(`[vo${idx}]`);
  idx++;
}

const sfx = [];
const add = (file, at, vol) => sfx.push({ file, at: Math.max(0, at), vol });
if (!a['no-sfx'] && plan.sfx !== false) {
  const keys = fs.readdirSync(path.join(ASSETS, 'sfx/keyboard')).map((f) => `keyboard/${f}`);
  for (const seg of segments) {
    if (seg.name === 'intro') add('impact/impactSoft_medium_001.ogg', seg.offset + 0.6, 0.55);
    else if (seg.name?.startsWith('chapter:')) add('impact/impactSoft_medium_002.ogg', seg.offset + 0.25, 0.45);
    else if (seg.name === 'outro') add('impact/impactBell_heavy_000.ogg', seg.offset + 0.3, 0.38);
    if (seg.kind !== 'shot') continue;
    if (seg.ltAt !== undefined) add('interface/drop_001.ogg', seg.offset + seg.ltAt, 0.32);
    for (const e of seg.evs) {
      const at = seg.offset + e.lt;
      if (e.type === 'click') add(fmt.mobile ? 'ui/click2.ogg' : 'interface/click_003.ogg', at - 0.01, 0.55);
      else if (e.type === 'key') add('interface/click_002.ogg', at, 0.35);
      else if (e.type === 'drag') add('casino/card-slide-1.ogg', at, 0.35);
      else if (e.type === 'type') {
        const span = Math.max(0.05, e.ltEnd - e.lt), step = span / Math.max(1, e.chars);
        for (let c = 0; c < e.chars; c += 2) add(keys[(c * 7 + e.chars) % keys.length], at + c * step, 0.16);
      }
    }
  }
}
const sfxLabels = [];
const byFile = Object.groupBy(sfx, (x) => x.file);
for (const [file, uses] of Object.entries(byFile)) {
  audioIn.push('-i', path.join(ASSETS, 'sfx', file));
  const outs = uses.map((_, j) => `[s${idx}_${j}]`);
  graph.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=${uses.length}${outs.map((o) => o.replace('[s', '[p')).join('')}`);
  uses.forEach((u, j) => {
    graph.push(`[p${idx}_${j}]volume=${u.vol},adelay=${Math.round(u.at * 1000)}:all=1[s${idx}_${j}]`);
    sfxLabels.push(`[s${idx}_${j}]`);
  });
  idx++;
}

let musicFile = null;
if (!a['no-music'] && plan.music !== 'none') {
  if (a.music || (plan.music && plan.music !== 'auto' && fs.existsSync(plan.music))) musicFile = path.resolve(a.music || plan.music);
  else if (brand.music && (!plan.music || plan.music === 'auto')) musicFile = brand.music;
  else {
    const dir = bragMusicDir();
    const pick = plan.music && plan.music !== 'auto' ? plan.music : plan.form === 'long' ? 'vol-12' : 'vol-11';
    const f = dir && fs.readdirSync(dir).find((n) => n.endsWith('.mp3') && n.includes(pick));
    if (f) musicFile = path.join(dir, f);
    else console.warn('  ⚠ music: brag plugin library not found — rendering without a music bed');
  }
}

const mixIns = [];
const vol = (x) => `aformat=sample_rates=48000:channel_layouts=stereo,${x}`;
if (voLabels.length) {
  graph.push(`${voLabels.join('')}amix=inputs=${voLabels.length}:normalize=0:duration=longest,${vol('apad')},atrim=0:${TOTAL},asplit=2[vo][vokey]`);
  mixIns.push('[vo]');
}
if (sfxLabels.length) {
  graph.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:normalize=0:duration=longest,apad,atrim=0:${TOTAL}[sfx]`);
  mixIns.push('[sfx]');
}
if (musicFile) {
  audioIn.push('-stream_loop', '-1', '-i', musicFile);
  const bed = plan.musicVolume ?? 0.3;
  graph.push(`[${idx}:a]${vol(`atrim=0:${TOTAL},volume=${bed},afade=t=in:st=0:d=1.2,afade=t=out:st=${r3(TOTAL - 2.5)}:d=2.5`)}[bed]`);
  if (voLabels.length) graph.push(`[bed][vokey]sidechaincompress=threshold=0.02:ratio=9:attack=30:release=450:makeup=1[mus]`);
  else graph.push(`[bed]anull[mus]`);
  mixIns.push('[mus]');
  idx++;
} else if (voLabels.length) graph.push(`[vokey]anullsink`);
if (!mixIns.length) die('nothing to mix — no VO, SFX or music');
graph.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:duration=longest,atrim=0:${TOTAL},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);

// ---------- 4. captions ----------
const cues = [];
const maxWords = plan.form === 'short' ? 4 : 8;
for (const seg of segments) {
  if (seg.kind !== 'shot' || !seg.vo) continue;
  let cur = [];
  const flush = () => { if (cur.length) cues.push({ start: cur[0].s, end: cur.at(-1).e, text: cur.map((w) => w.w).join(' ') }); cur = []; };
  for (const w of seg.vo.words) {
    const g = { w: w.w, s: seg.offset + VO_LEAD + w.start, e: seg.offset + VO_LEAD + w.end };
    if (cur.length && (cur.length >= maxWords || g.s - cur.at(-1).e > 0.5)) flush();
    cur.push(g);
    if (/[.!?…,;:]$/.test(w.w) && cur.length >= 2) flush();
  }
  flush();
}
cues.forEach((c, k) => { c.end = Math.min(c.end + 0.15, cues[k + 1]?.start ?? Infinity); if (c.end - c.start < 0.7) c.end = Math.min(c.start + 0.7, cues[k + 1]?.start ?? Infinity); });
const ts = (x, sep) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`; };
const base = plan.output || (fmt.mobile ? 'demo-vertical' : 'demo');
// Burned-in captions: keep the upload sidecar out of the video's folder, or players (VLC, Windows) auto-load it
// and show every caption twice.
const burn = plan.captions === 'burn' || plan.captions === 'both';
const srtFile = path.join(outDir, burn ? 'captions' : '', `${base}.srt`);
fs.mkdirSync(path.dirname(srtFile), { recursive: true });
fs.writeFileSync(srtFile, cues.map((c, k) => `${k + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`).join('\n'));

let vchain = '[0:v]null';
if (cues.length && burn) {
  const fontsDir = workDir(outDir, 'fonts');
  if (brand.font) fs.copyFileSync(brand.font, path.join(fontsDir, path.basename(brand.font)));
  const capFont = brand.fontFamily || 'Arial';
  const fs_ = fmt.mobile ? 62 : 46, mv = fmt.mobile ? 430 : 64;
  const assTime = (x) => ts(x, '.').slice(1, -1);
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,${capFont},${fs_},&H00FFFFFF,&H00FFFFFF,${assColor(brand.colors.primary, 0x1a)},&H00000000,-1,0,0,0,100,100,0,0,3,14,0,2,80,80,${mv},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${c.text.replace(/[{}]/g, '')}`).join('\n') + '\n';
  fs.writeFileSync(path.join(work, 'captions.ass'), ass);
  vchain = `[0:v]subtitles=captions.ass:fontsdir=fonts`;
}
graph.unshift(`${vchain},${TO_BT709}[vout]`);

// ---------- 5. final render ----------
const graphFile = path.join(editDir, 'final.filter');
fs.writeFileSync(graphFile, graph.join(';\n'));
const outFile = path.join(outDir, `${base}.mp4`);
console.log(`\nmixing ${voLabels.length} VO · ${sfx.length} SFX · ${musicFile ? path.basename(musicFile) : 'no music'} → ${path.basename(outFile)} (${TOTAL}s)`);
ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(editDir, 'concat.txt'), ...audioIn, '-/filter_complex', graphFile,
  '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', a.draft ? 'veryfast' : 'slow', '-crf', '18', ...BT709_TAGS,
  '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(TOTAL), outFile], { cwd: work });

const chapters = [{ name: 'Intro', at: 0 }];
for (const seg of segments) {
  const name = seg.name?.startsWith('chapter:') ? seg.name.slice(8) : seg.kind === 'shot' ? seg.def.chapter : null;
  if (name && !chapters.some((c) => c.name === name)) chapters.push({ name, at: seg.offset });
}
if (plan.form === 'long') {
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.map((c) => `${mmss(c.at)} ${c.name}`).join('\n') + '\n');
}
fs.writeFileSync(path.join(editDir, 'timeline.json'), JSON.stringify({ total: TOTAL, segments: segments.map((s) => ({ kind: s.kind, id: s.id, name: s.name, offset: s.offset, len: s.len, speed: s.speed })) }, null, 2));
console.log(`done → ${path.relative(process.cwd(), outFile)} · ${path.relative(outDir, srtFile)}${plan.form === 'long' ? ' · chapters.txt' : ''}`);
