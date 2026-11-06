// Plays src/index.html frame by frame in headless Chrome and hands the frames to ffmpeg.
//   node render.mjs cues                     write out/cues.json (when each voice line and sound plays)
//   node render.mjs still 8.2 21 34 ...      one PNG per time, in out/stills
//   node render.mjs video [workers] [scale]  the whole film, into out/picture.mp4
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 60;
const [mode, ...args] = process.argv.slice(2);

async function open(scale = 1) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, pipe: true, protocolTimeout: 0, userDataDir: path.join(process.env.TMPDIR ?? '/tmp', `u7-chrome-${process.pid}-${Math.random().toString(36).slice(2)}`),
    args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-background-timer-throttling', '--allow-file-access-from-files'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: scale },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(pathToFileURL(path.join(ROOT, 'src/index.html')).href + `?dpr=${scale}`);
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  return { browser, page, client: await page.createCDPSession() };
}
const shot = async (client) => Buffer.from((await client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true })).data, 'base64');

if (mode === 'cues') {
  const { browser, page } = await open();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'cues.json'), JSON.stringify(await page.evaluate('window.__cues()'), null, 1));
  await browser.close();
} else if (mode === 'still') {
  const { browser, page, client } = await open();
  mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  for (const t of args) {
    const started = Date.now();
    await page.evaluate(`__seek(${Math.round(+t * FPS)})`);
    writeFileSync(path.join(OUT, 'stills', `${(+t).toFixed(2).padStart(6, '0')}.png`), await shot(client));
    console.log(t, Date.now() - started, 'ms');
  }
  await browser.close();
} else if (mode === 'video') {
  // samples > 1 is motion blur: each frame averages that many instants across half a frame (a 180 degree shutter).
  const workers = +(args[0] ?? 4), scale = +(args[1] ?? 1), samples = +(args[2] ?? 1);
  const probe = await open(); const total = await probe.page.evaluate('window.__frames'); await probe.browser.close();
  const [first, last] = (process.env.RANGE ?? `0-${total}`).split('-').map(Number), count = last - first;
  const dir = path.join(OUT, 'chunks'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const t0 = Date.now(); const done = new Array(workers).fill(0);
  const report = setInterval(() => { const n = done.reduce((a, b) => a + b); console.log(`${n}/${count}  ${(n / ((Date.now() - t0) / 1000)).toFixed(1)} fps`); }, 30000);
  const colour = 'scale=out_color_matrix=bt709:out_range=tv';
  const vf = samples > 1 ? `tmix=frames=${samples},select='eq(mod(n+1,${samples}),0)',setpts=N/(${FPS}*TB),${colour}` : colour;
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const from = first + Math.floor(count * w / workers), to = first + Math.floor(count * (w + 1) / workers);
    const { browser, page, client } = await open(scale);
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS * samples), '-c:v', 'png', '-i', '-', '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '13', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', path.join(dir, `${String(w).padStart(2, '0')}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let f = from; f < to; f++) {
      for (let s = 0; s < samples; s++) {
        await page.evaluate(`__seek(${f + (s / samples) * .5})`);
        const png = await shot(client);
        if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      }
      done[w]++;
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r)); await browser.close();
  }));
  clearInterval(report);
  const list = path.join(dir, 'list.txt');
  writeFileSync(list, Array.from({ length: workers }, (_, w) => `file '${String(w).padStart(2, '0')}.mp4'`).join('\n'));
  await new Promise((r) => spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(OUT, 'picture.mp4')], { stdio: 'inherit' }).on('close', r));
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
}
