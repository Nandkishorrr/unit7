// What every page shares: the shader's conductor, the wipe, nav, moods, Warden, copy buttons, tabs and the pause.
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { moodOf, renderOnce, shaderTick, startShader, u, type Mood } from './shader';

gsap.registerPlugin(ScrollTrigger);
gsap.defaults({ ease: 'power3.out' });
export { gsap, ScrollTrigger, u };

const root = document.documentElement;
(window as unknown as { __u7: boolean }).__u7 = true;

/** Set in <head>: JS ran, the visitor didn't ask for less motion, and the site isn't paused. */
export const MOTION = root.classList.contains('motion');
export const slash = 0.62;
const page = (root.dataset.page ?? 'night') as Mood;

// --- Shader ---------------------------------------------------------------------------------------------------
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const start = moodOf(page === 'dawn' ? 'dawn' : page === 'day' ? 'day' : 'night');
u.pal = [...start.pal]; u.horizon = start.horizon; u.day = start.day;
u.intensity = MOTION ? 0 : page === 'night' ? 1 : start.intensity;
const hasGL = startShader(canvas, { still: !MOTION });
if (!hasGL) root.classList.add('nogl');
if (MOTION && hasGL) {
  gsap.ticker.add((t) => shaderTick(t * 1000));
  gsap.to(u, { intensity: page === 'night' ? 1 : start.intensity, duration: 1.1, ease: 'power2.out' });
}

let mood: Mood = page, power = page === 'night' ? 1 : start.intensity;
export function setMood(next: Mood, intensity?: number) {
  const m = moodOf(next);
  const target = intensity ?? m.intensity;
  if (next === mood && target === power) return;
  mood = next; power = target;
  face?.style.setProperty('--mood', next === 'alert' ? '#FBBF24' : '#C6F432');
  const to = { intensity: target, horizon: m.horizon, day: m.day };
  if (!MOTION) { u.pal = [...m.pal]; Object.assign(u, to); renderOnce(); return; }
  gsap.to(u.pal, { endArray: m.pal, duration: 1.4, ease: 'power2.inOut', overwrite: true });
  gsap.to(u, { ...to, duration: 1.4, ease: 'power2.inOut', overwrite: 'auto' });
}

// --- The wipe. Every headline arrives line by line behind an edge at the 7's angle. -------------------------------
const easeOut = gsap.parseEase('power3.out');
export function setWipe(el: HTMLElement, st: number[], band: number) {
  const W = el.offsetWidth, k = band * slash, pad = band * .4;
  let p = `${-pad}px ${-pad}px`;
  st.forEach((t, i) => {
    const x = t >= 1 ? W + pad * 2 + k : t * (W + k + pad * 2) - k;
    p += `,${x + k}px ${i ? i * band : -pad}px,${x}px ${(i + 1) * band + (i === st.length - 1 ? pad : 0)}px`;
  });
  el.style.clipPath = `polygon(${p},${-pad}px ${st.length * band + pad}px)`;
}
export function wipe(el: HTMLElement, { delay = 0, dur = .85, stagger = .1, y = 0, block = false } = {}) {
  const lh = block ? el.offsetHeight : parseFloat(getComputedStyle(el).lineHeight) || el.offsetHeight;
  const n = Math.max(1, Math.round(el.offsetHeight / lh)), band = el.offsetHeight / n;
  const st = new Array(n).fill(0), total = dur + stagger * (n - 1), s = { t: 0 };
  setWipe(el, st, band);
  el.style.visibility = 'visible';
  if (y) gsap.fromTo(el, { y }, { y: 0, duration: total, delay });
  return gsap.to(s, {
    t: total, duration: total, delay, ease: 'none',
    onUpdate() {
      for (let i = 0; i < n; i++) st[i] = easeOut(Math.min(1, Math.max(0, (s.t - i * stagger) / dur)));
      setWipe(el, st, band);
    },
    onComplete() { el.style.clipPath = ''; },
  });
}

// Count up. The real number is already in the HTML. A big stat stands alone, so it holds its width and starts at zero.
// A number inside a sentence starts from the smallest value with the same digits (1,000 up to 1,240), so its width
// never changes and the words around it stay put.
export function count(el: HTMLElement, { duration = 1.3, delay = 0 } = {}) {
  const end = parseFloat(el.dataset.count!), text = el.textContent!;
  const dec = (el.dataset.count!.split('.')[1] ?? '').length;
  const alone = el.classList.contains('num');
  if (alone) el.style.minWidth = `${el.offsetWidth}px`;
  const s = { v: alone || end < 10 ? 0 : 10 ** Math.floor(Math.log10(end)) };
  el.textContent = s.v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return gsap.to(s, {
    v: end, duration, delay, ease: 'power2.out',
    onUpdate() { el.textContent = s.v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); },
    onComplete() { el.textContent = text; },
  });
}

// --- Nav: hides going down, returns going up ----------------------------------------------------------------------
const nav = document.getElementById('nav')!;
const opener = document.querySelector('main > section');   // the nav stays clear over the first section
let lastY = scrollY;
const onScroll = () => {
  const y = scrollY, solid = !!opener && opener.getBoundingClientRect().bottom < 80;
  nav.classList.toggle('nav--solid', solid);
  nav.classList.toggle('nav--shade', !solid && y > 8);
  if (Math.abs(y - lastY) > 6) { nav.classList.toggle('nav--hide', y > lastY && y > 240); lastY = y; }
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();
addEventListener('click', (e) => {          // the phone menu closes when you tap away
  const menu = nav.querySelector('details');
  if (menu?.open && !menu.contains(e.target as Node)) menu.open = false;
});

// --- Copy buttons -------------------------------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
  const code = btn.closest('.term')!.querySelector('code')!;
  let timer = 0;
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(btn.dataset.copy || code.textContent!); }
    catch { getSelection()?.selectAllChildren(code); return; }   // no clipboard here: select it instead
    btn.classList.remove('done'); void btn.offsetWidth; btn.classList.add('done');
    clearTimeout(timer); timer = window.setTimeout(() => btn.classList.remove('done'), 1800);
  });
});

// --- Tabs. With no JS every panel is simply shown. -----------------------------------------------------------------
document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((list) => {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const show = (tab: HTMLButtonElement, focus = false) => {
    tabs.forEach((t) => {
      const on = t === tab, panel = document.getElementById(t.getAttribute('aria-controls')!)!;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; panel.hidden = !on;
      if (on && MOTION) wipe(panel, { dur: .6, block: true });
    });
    if (focus) tab.focus();
    ScrollTrigger.refresh();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => show(tab));
    tab.addEventListener('keydown', (e) => {
      const go = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (go === undefined) return;
      e.preventDefault(); show(tabs[(go + tabs.length) % tabs.length], true);
    });
  });
  tabs.forEach((t) => {
    const on = t.getAttribute('aria-selected') === 'true';
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')!)!.hidden = !on;
  });
});

// --- Warden -------------------------------------------------------------------------------------------------------
const warden = document.getElementById('warden');
const face = warden?.querySelector<SVGElement>('.warden-face') ?? null;
const say = warden?.querySelector<HTMLElement>('.warden__say');
let wardenOff = false;
try { wardenOff = sessionStorage.getItem('u7-warden') === 'off'; } catch { /* private mode: it just comes back */ }

let sayTimer = 0;
export function hush() {
  clearTimeout(sayTimer);
  if (say) say.hidden = true;
  warden?.classList.remove('warden--talking');
}
export function speak(line: string) {
  if (!warden || !say || wardenOff || u.pause) return;
  warden.hidden = false;
  say.textContent = line; say.hidden = false;
  warden.classList.add('warden--talking');
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(hush, innerWidth < 900 ? 3000 : 4600);
}
warden?.querySelector('.warden__x')?.addEventListener('click', () => {
  wardenOff = true; warden.hidden = true;
  try { sessionStorage.setItem('u7-warden', 'off'); } catch { /* fine */ }
});

// --- The pause. It freezes the shader, GSAP's global timeline and every CSS animation. -----------------------------
const note = document.getElementById('pausenote')!;
const paused = root.classList.contains('paused');   // already paused when this page loaded
export function setPaused(on: boolean) {
  try { on ? sessionStorage.setItem('u7-paused', '1') : sessionStorage.removeItem('u7-paused'); } catch { /* session only */ }
  if (!on && paused) { location.reload(); return; }  // this page loaded still, so it has no motion to restore
  u.pause = on;
  root.classList.toggle('paused', on);
  note.hidden = !on;
  on ? gsap.globalTimeline.pause() : gsap.globalTimeline.resume();
  document.dispatchEvent(new CustomEvent('u7-pause', { detail: on }));
  if (on) hush();
}
if (paused) { note.hidden = false; u.pause = true; }
note.querySelector('[data-resume]')!.addEventListener('click', () => setPaused(false));

// --- Sections: moods, Warden's lines, wipes -----------------------------------------------------------------------
document.querySelectorAll<HTMLElement>('[data-mood]').forEach((sec) => {
  ScrollTrigger.create({
    trigger: sec, start: 'top 55%', end: 'bottom 45%',
    onToggle: (self) => { if (self.isActive) setMood(sec.dataset.mood as Mood, sec.dataset.power ? +sec.dataset.power : undefined); },
  });
});
document.querySelectorAll<HTMLElement>('[data-warden]').forEach((sec) => {
  ScrollTrigger.create({ trigger: sec, start: 'top 45%', once: true, onEnter: () => speak(sec.dataset.warden!) });
});
document.querySelectorAll('[data-opaque]').forEach((el) => {
  ScrollTrigger.create({ trigger: el, start: 'top top', end: 'bottom bottom', onToggle: (self) => { u.covered = self.isActive; } });
});
// Warden turns up once the first screen is behind you.
if (opener && warden && !wardenOff && innerWidth >= 900) {
  ScrollTrigger.create({ trigger: opener, start: 'bottom 40%', once: true, onEnter: () => { warden.hidden = false; } });
}

if (MOTION) {
  document.querySelectorAll<HTMLElement>('[data-wipe]:not([data-intro])').forEach((el) => {
    el.style.visibility = 'hidden';
    ScrollTrigger.create({
      trigger: el, start: 'top 86%', once: true,
      onEnter: () => { if (root.classList.contains('paused')) { el.style.visibility = ''; return; } wipe(el, { y: 18 }); },
    });
  });
  document.querySelectorAll<HTMLElement>('[data-count]:not([data-count-manual])').forEach((el) => {
    ScrollTrigger.create({ trigger: el, start: 'top 88%', once: true, onEnter: () => { if (!u.pause) count(el); } });
  });
  // A paused page can't run its wipes, so show whatever was waiting.
  document.addEventListener('u7-pause', (e) => {
    if (!(e as CustomEvent).detail) return;
    document.querySelectorAll<HTMLElement>('[data-wipe]').forEach((el) => { el.style.visibility = ''; });
  });
}

// ScrollTrigger measures once more when late things change the layout. An opened <details> moves all that's below it.
document.fonts?.ready.then(() => ScrollTrigger.refresh());
addEventListener('load', () => ScrollTrigger.refresh());
document.querySelectorAll('main details').forEach((d) => d.addEventListener('toggle', () => gsap.delayedCall(.45, () => ScrollTrigger.refresh())));

// V2 and Open source: the first heading arrives the same way, in the same order as Home.
export function pageIntro() {
  const items = [...document.querySelectorAll<HTMLElement>('[data-intro]')];
  if (!MOTION) { items.forEach((el) => { el.style.visibility = ''; }); return; }
  items.forEach((el, i) => wipe(el, { delay: .25 + i * .16, dur: .85, y: 14 }));
}
