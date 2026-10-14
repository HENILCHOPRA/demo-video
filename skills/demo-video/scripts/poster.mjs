// Pick a settled frame as the poster and bake it in as frame 0 (brag's thumbnail trick).
// Usage: node poster.mjs <out-dir> [--at <seconds>]   (default: outro card, fully settled)
import fs from 'node:fs';
import path from 'node:path';
import { BT709_TAGS, TO_BT709, args, die, ffmpeg, loadPlan } from './lib.mjs';

const a = args();
const outDir = path.resolve(a._[0] || die('usage: node poster.mjs <out-dir> [--at s]'));
const { plan, fmt } = loadPlan(outDir);
const base = plan.output || (fmt.mobile ? 'demo-vertical' : 'demo');
const video = path.join(outDir, `${base}.mp4`);
const tl = JSON.parse(fs.readFileSync(path.join(outDir, 'work/edit/timeline.json'), 'utf8'));
const outro = tl.segments.find((s) => s.name === 'outro');
const at = a.at !== undefined ? Number(a.at) : outro.offset + Math.min(2.2, outro.len - 0.3);
const jpg = path.join(outDir, `${base}.jpg`);
ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '2', jpg]);
const tmp = path.join(outDir, `${base}.poster.mp4`);
ffmpeg(['-i', video, '-i', jpg, '-filter_complex', `[1:v]${TO_BT709}[p];[0:v][p]overlay=0:0:enable='eq(n,0)',${TO_BT709}[v]`, '-map', '[v]', '-map', '0:a?',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', ...BT709_TAGS, '-c:a', 'copy', '-movflags', '+faststart', tmp]);
fs.renameSync(tmp, video);
console.log(`poster @${at}s → ${path.basename(jpg)} (baked as frame 0)`);
