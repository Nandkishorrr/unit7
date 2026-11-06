// Home. Everything here is progressive: without motion the page is already complete, this only adds to it.
import { gsap, ScrollTrigger, MOTION, u, wipe, setMood, setPaused, slash } from './motion';
import { renderOnce } from './shader';
import './real';

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)!;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];
const smooth = (a: number, b: number, t: number) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };

const mm = gsap.matchMedia();
const DESK = '(min-width: 900px)', PHONE = '(max-width: 899px)';

// --- Hero. The 7 assembles the way the product's mark does: bar slides in, stroke draws down, a glint passes. --------
u.mark = 1;
if (MOTION) {
  gsap.timeline()
    .to(u, { bar: 1, duration: .5, ease: 'power3.out' }, .2)
    .to(u, { stroke: 1, duration: .5, ease: 'power2.inOut' }, .5)
    .to(u, { glint: 37, duration: 1, ease: 'power1.inOut' }, .82);
  const [eyebrow, h1, lede, cta, small] = $$('[data-intro]');
  wipe(h1, { delay: .55, dur: .75, stagger: .09, y: 16 });
  wipe(eyebrow, { delay: 1, dur: .5 });
  wipe(lede, { delay: 1.08, dur: .6, stagger: .05 });
  wipe(cta, { delay: 1.2, dur: .5 });
  wipe(small, { delay: 1.3, dur: .4 });

  // First scroll: the camera goes through the gap of the 7. Zoom is exponential, and it starts slowly so the mark lingers.
  const fly = { t: 0, fadeFrom: .88, curve: 2.2 };
  const flown = () => {
    const t = fly.t;
    u.zoom = Math.pow(40, Math.pow(t, fly.curve));
    u.shift = smooth(0, .55, t);
    u.fieldZoom = 1 - .62 * t;
    u.mark = 1 - smooth(fly.fadeFrom, 1, t);
  };
  mm.add({ desk: DESK, phone: PHONE }, (ctx) => {
    const desk = ctx.conditions!.desk;
    // A phone has no pin, so the next headline arrives while the 7 is still flying. The 7 has to be gone first.
    fly.fadeFrom = desk ? .88 : .55;
    fly.curve = desk ? 2.2 : 1.5;   // on a desktop the 7 stays in frame until the next headline is about to arrive
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: '.hero', start: 'top top', end: desk ? 'bottom bottom' : 'bottom 62%', scrub: desk ? .6 : .3 },
    });
    tl.to(fly, { t: 1, duration: 1, onUpdate: flown }, 0);
    if (desk) tl.to('.hero__copy', { y: -130, opacity: 0, duration: .4 }, 0).to('.hero__pin', { '--scrim': 0, duration: .4 }, 0);
  });
} else {
  u.bar = 1; u.stroke = 1;
  renderOnce();
  // The canvas is fixed, so the still 7 has to step out once the hero is gone.
  ScrollTrigger.create({ trigger: '.hero', start: 'bottom 60%', onToggle: (self) => { u.mark = self.isActive ? 0 : 1; renderOnce(); }, end: 'max' });
}

// --- The problem: the words light up as you scroll ---------------------------------------------------------------------
if (MOTION) {
  const items = $$('.problem__list li');
  gsap.set(items, { opacity: .14 });
  gsap.timeline({ scrollTrigger: { trigger: '.problem__list', start: 'top 74%', end: 'bottom 48%', scrub: .6 } })
    .to(items, { opacity: 1, duration: .5, stagger: .6, ease: 'none' });
}

// --- The demo. One builder per beat. A desktop strings them on the scroll; a phone plays each as it arrives. ------------
if (MOTION) {
  const typed = $('.bubble__t'), full = typed.textContent!, bubble = $('.bubble');
  const step = $('.step'), tick = $<SVGPathElement>('.step path'), looking = $('.answer__sk');
  const card = $('.chat__c'), approve = $('.pill--blue'), receipt = $('.chat__r'), none = $('.chat__none');

  // Words appear one by one. `code` stays whole, so a long error arrives as one thing, like in the product.
  const answer = $('.answer');
  [...answer.childNodes].forEach((n) => {
    if (n.nodeType !== 3) { (n as HTMLElement).classList.add('w'); return; }
    const frag = document.createDocumentFragment();
    n.textContent!.split(/(\s+)/).forEach((w) => {
      if (!w) return;
      if (/^\s+$/.test(w)) { frag.append(w); return; }
      const s = document.createElement('span'); s.className = 'w'; s.textContent = w; frag.append(s);
    });
    n.replaceWith(frag);
  });
  const words = $$('.answer .w');

  const typeTo = { n: 0 };
  const write = () => { typed.textContent = full.slice(0, Math.round(typeTo.n)); };
  const reset = () => {
    typeTo.n = 0; write();
    gsap.set(bubble, { opacity: 0 });
    gsap.set(step, { opacity: 0, y: 12 });
    gsap.set(tick, { attr: { 'stroke-dasharray': 16, 'stroke-dashoffset': 16 } });
    gsap.set(looking, { opacity: 0 });
    gsap.set(words, { opacity: 0 });
    gsap.set(card, { opacity: 0, y: 26 });
    gsap.set(receipt, { opacity: 0, y: 12 });
    gsap.set(none, { opacity: 1 });
  };
  const beat: ((stacked?: boolean) => gsap.core.Timeline)[] = [
    () => gsap.timeline({ defaults: { ease: 'none' } })
      .set(bubble, { opacity: 1 })
      .to(typeTo, { n: full.length, duration: 1.2, onUpdate: write }),
    () => gsap.timeline({ defaults: { ease: 'none' } })
      .to(step, { opacity: 1, y: 0, duration: .3 })
      .to(looking, { opacity: 1, duration: .2 }, '<.1')
      .to(tick, { attr: { 'stroke-dashoffset': 0 }, duration: .25 }, '+=.25')
      .to(looking, { opacity: 0, duration: .15 })
      .to(words, { opacity: 1, duration: .06, stagger: .022 }, '<.05'),
    () => gsap.timeline({ defaults: { ease: 'none' } })
      .to(none, { opacity: 0, duration: .2 })
      .to(card, { opacity: 1, y: 0, duration: .5, ease: 'power2.out' }, '<.05'),
    (stacked) => {
      const tl = gsap.timeline({ defaults: { ease: 'none' } })
        .to(approve, { scale: .93, duration: .14 })
        .to(approve, { scale: 1, backgroundColor: '#4ADE80', color: '#06270F', duration: .14 });
      if (!stacked) tl.to(card, { opacity: 0, y: -10, duration: .3 }, '+=.12');   // on a desktop they share one slot
      return tl.to(receipt, { opacity: 1, y: 0, duration: .3 }, '-=.1');
    },
  ];

  mm.add(DESK, () => {
    reset();
    const texts = $$('.demo__texts li');
    const ticks = $$('.demo__ticks i');
    texts.forEach((li, i) => {
      gsap.set(li, { '--k': `${li.offsetHeight * slash}px`, '--p': i ? 0 : 1, '--q': 0, visibility: 'visible' });
    });
    gsap.set(ticks, { backgroundColor: 'rgba(255,255,255,.13)' });
    gsap.set(ticks[0], { backgroundColor: '#C6F432' });
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: '.demo', start: 'top top', end: 'bottom bottom', scrub: .7, invalidateOnRefresh: false },
    });
    const swap = (i: number) => {
      tl.to(texts[i - 1], { '--q': 1, duration: .4 }, '+=.3');
      tl.to(texts[i], { '--p': 1, duration: .45 }, '-=.2');
      tl.set(ticks[i], { backgroundColor: '#C6F432' }, '-=.3');
    };
    tl.add(beat[0](), .15);
    swap(1); tl.add(beat[1](), '-=.1');
    swap(2); tl.add(beat[2](), '-=.15');
    swap(3); tl.add(beat[3](), '-=.05');
    tl.to({}, { duration: .5 });
    return () => { typed.textContent = full; };
  });

  mm.add(PHONE, () => {
    reset();
    [$('.chat__q'), $('.chat__a'), card, receipt].forEach((part, i) => {
      ScrollTrigger.create({
        trigger: i === 2 ? '.chat__a' : part, start: i === 2 ? 'bottom 70%' : 'top 78%', once: true,
        onEnter: () => beat[i](true).play(),
      });
    });
    return () => { typed.textContent = full; };
  });
}

// --- Gallery: the vertical scroll moves it sideways. Native snap on a phone. ---------------------------------------------
if (MOTION) mm.add(DESK, () => {
  const stage = $('.gallery__stage'), track = $('.gallery__track');
  const slide = gsap.to(track, {
    x: () => -(track.scrollWidth - stage.clientWidth), ease: 'none',
    scrollTrigger: {
      trigger: '.gallery', start: 'top top', end: 'bottom bottom', scrub: .6, invalidateOnRefresh: true,
      onUpdate: (self) => gsap.set('.gallery__bar i', { scaleX: self.progress }),
    },
  });
  $$('.shot').forEach((shot) => {
    const frame = $('.shot__frame', shot);
    gsap.fromTo(frame, { '--p': 0 }, { '--p': 1, ease: 'none', scrollTrigger: { trigger: shot, containerAnimation: slide, start: 'left 98%', end: 'left 42%', scrub: true } });
    gsap.fromTo($('img', shot), { xPercent: -1.6 }, { xPercent: 1.6, ease: 'none', scrollTrigger: { trigger: shot, containerAnimation: slide, start: 'left right', end: 'right left', scrub: true } });
  });
});

// --- One gate. HTML nodes, measured; one drawn route. So the same code draws it across a desk or down a phone. -----------
{
  type P = { x: number; y: number; id?: string };
  const map = $('.gate__map'), svg = $('.gate__svg'), rails = $('.gate__rails');
  const trail = $<SVGPathElement>('.gate__trail'), pulse = $<SVGCircleElement>('.gate__pulse');
  const nodes = $$('[data-node]'), picks = $$<HTMLButtonElement>('.gate__pick');
  const say = document.createElement('p'); say.className = 'sr'; say.setAttribute('aria-live', 'polite'); map.after(say);
  let safe: P[] = [], risky: P[] = [];

  const at = (id: string): P => {
    const d = $('.gate__dot', $(`[data-node="${id}"]`)).getBoundingClientRect(), m = map.getBoundingClientRect();
    return { x: d.left + d.width / 2 - m.left, y: d.top + d.height / 2 - m.top, id };
  };
  const line = (pts: P[]) => `M${pts.map((p) => `${p.x} ${p.y}`).join('L')}`;
  const measure = () => {
    const [who, role, place, person, approve, backup, run, redact, audit] = nodes.map((n) => at(n.dataset.node!));
    const wide = Math.abs(run.x - person.x) > Math.abs(run.y - person.y);
    // Both ways round the fork leave or join along the slash, so together they draw one parallelogram.
    const early: P = wide ? { x: person.x + slash * Math.abs(approve.y - person.y), y: approve.y } : { x: approve.x, y: person.y + Math.abs(approve.x - person.x) / slash };
    const late: P = wide ? { x: run.x - slash * Math.abs(run.y - person.y), y: person.y } : { x: person.x, y: run.y - Math.abs(run.x - person.x) / slash };
    const head = [who, role, place, person], tail = [run, redact, audit];
    safe = [...head, late, ...tail];
    risky = [...head, early, approve, backup, ...tail];
    rails.innerHTML = `<path d="${line(safe)}"/><path d="${line(risky)}"/>`;
    svg.setAttribute('viewBox', `0 0 ${map.offsetWidth} ${map.offsetHeight}`);
  };

  const clear = () => {
    nodes.forEach((n) => n.classList.remove('lit', 'wait'));
    map.classList.remove('is-wait');
  };
  const light = (id?: string) => { if (id) $(`[data-node="${id}"]`).classList.add('lit'); };

  const route = (id: string) => (id === 'delete' ? risky : safe);
  const choose = (id: string) => {
    picks.forEach((b) => {
      const on = b.dataset.route === id;
      b.setAttribute('aria-pressed', String(on));
      b.parentElement!.classList.toggle('on', on);
      if (on) say.textContent = b.nextElementSibling!.textContent;
    });
  };

  let run: gsap.core.Timeline | null = null, wait: gsap.core.Tween | null = null, seen = false, next = 0;
  const order = picks.map((b) => b.dataset.route!);

  const play = (id: string) => {
    run?.kill(); wait?.kill(); clear(); choose(id);
    const pts = route(id);
    const seg = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = seg.reduce((a, b) => a + b, 0), speed = total / 2.6;
    trail.setAttribute('d', line(pts));
    trail.setAttribute('pathLength', '1');
    gsap.set(trail, { strokeDashoffset: 1 });
    gsap.set(pulse, { attr: { cx: pts[0].x, cy: pts[0].y }, opacity: 1 });
    light(pts[0].id);
    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    let done = 0;
    pts.slice(1).forEach((p, i) => {
      done += seg[i];
      const d = seg[i] / speed;
      tl.to(pulse, { attr: { cx: p.x, cy: p.y }, duration: d }, '>')
        .to(trail, { strokeDashoffset: 1 - done / total, duration: d }, '<')
        .call(light, [p.id]);
      if (p.id === 'approve') {       // it stops here, turns amber and waits for a person
        tl.call(() => { map.classList.add('is-wait'); $('[data-node="approve"]').classList.add('wait'); })
          .to({}, { duration: 1.5 })
          .call(() => { map.classList.remove('is-wait'); $('[data-node="approve"]').classList.remove('wait'); });
      }
    });
    tl.to(pulse, { opacity: 0, duration: .3 }, '+=.15')
      .call(() => { if (seen) wait = gsap.delayedCall(1.5, () => { next = (order.indexOf(id) + 1) % order.length; play(order[next]); }) as unknown as gsap.core.Tween; });
    run = tl;
  };

  picks.forEach((b) => b.addEventListener('click', () => {
    if (MOTION) play(b.dataset.route!);
    else { choose(b.dataset.route!); clear(); route(b.dataset.route!).forEach((p) => light(p.id)); }
  }));

  measure();
  new ResizeObserver(() => { measure(); if (MOTION && seen) play(order[next]); else if (MOTION) gsap.set(pulse, { opacity: 0 }); }).observe(map);
  document.fonts?.ready.then(measure);

  if (MOTION) ScrollTrigger.create({
    trigger: map, start: 'top 82%', end: 'bottom 12%',
    onToggle: (self) => {
      seen = self.isActive;
      if (seen) { if (run?.paused() || !run) { if (run) run.resume(); else play(order[next]); } }
      else run?.pause();
    },
  });
  else route('read').forEach((p) => light(p.id));
}

// --- Autonomy. The radios work on their own in CSS; this adds the wipe and turns the shader up with the level. ----------
{
  const radios = $$<HTMLInputElement>('input[name="level"]');
  const POWER = [.42, .6, .8, 1.02, 1.3];
  const paint = () => {
    const i = radios.findIndex((r) => r.checked);
    setMood(i === 4 ? 'safe' : i === 0 ? 'deep' : 'night', POWER[i]);
  };
  ScrollTrigger.create({ trigger: '.auto', start: 'top 55%', end: 'bottom 45%', onToggle: (self) => { if (self.isActive) paint(); } });
  radios.forEach((r) => r.addEventListener('change', () => {
    paint();
    if (MOTION) wipe($(`[data-l="${r.value}"] .says__line`), { dur: .6, stagger: .07 });
  }));
}

// --- Hold to pause everything ----------------------------------------------------------------------------------------
{
  const btn = $<HTMLButtonElement>('#hold'), fill = $('.holdbtn__fill'), label = $('.holdbtn__t');
  let fillTween: gsap.core.Tween | null = null, justHeld = false;
  const on = () => document.documentElement.classList.contains('paused');
  const sync = () => {
    label.textContent = on() ? 'Turn Autopilot back on' : 'Hold to pause everything';
    gsap.set(fill, { scaleX: 0 });
  };
  const hold = () => {
    if (on() || fillTween) return;
    fillTween = gsap.to(fill, { scaleX: 1, duration: 1.2, ease: 'none', onComplete: () => { fillTween = null; justHeld = true; setPaused(true); sync(); } });
  };
  const drop = () => {
    if (!fillTween) return;
    fillTween.kill(); fillTween = null;
    gsap.to(fill, { scaleX: 0, duration: .25, ease: 'power2.out' });
  };
  btn.addEventListener('pointerdown', hold);
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(type, drop);
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); if (on()) { setPaused(false); sync(); } else hold(); } });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') drop(); });
  // Letting go after a full hold also fires a click. That click is the end of the hold, not a request to resume.
  btn.addEventListener('click', () => {
    if (justHeld) { justHeld = false; return; }
    if (on()) { setPaused(false); sync(); }
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('u7-pause', sync);
  sync();
}

// --- Proof: a sliver like the 7's stroke draws down, then widens along the slash until lime fills the screen. ----------
if (MOTION) {
  const open = $('.proof__open');
  const s = { p: 0 };
  const draw = () => {
    const W = open.offsetWidth, H = open.offsetHeight, k = H * slash;
    const down = smooth(0, .24, s.p), wide = gsap.parseEase('power2.in')(Math.min(1, Math.max(0, (s.p - .2) / .8)));
    const sliver = Math.min(W * .1, 150), w = sliver + (W + k + 4 - sliver) * wide;
    if (w >= W + k) { open.style.clipPath = 'none'; return; }
    const d = H * down, x = (y: number) => W * .5 + k * .5 - y * slash;
    open.style.clipPath = `polygon(${x(0) - w / 2}px 0,${x(0) + w / 2}px 0,${x(d) + w / 2}px ${d}px,${x(d) - w / 2}px ${d}px)`;
  };
  mm.add({ desk: DESK, phone: PHONE }, (ctx) => {
    const desk = ctx.conditions!.desk;
    draw();
    gsap.to(s, {
      p: 1, ease: 'none', onUpdate: draw,
      scrollTrigger: { trigger: '.proof__gate', start: desk ? 'top 82%' : 'top 95%', end: desk ? 'bottom bottom' : 'top 8%', scrub: .5 },
    });
    return () => { open.style.clipPath = ''; };
  });
  document.addEventListener('u7-pause', (e) => { if (!(e as CustomEvent).detail) draw(); });
}

// --- Dawn band: the horizon begins to rise ------------------------------------------------------------------------------
if (MOTION) {
  // It rises under the band's own text, then sets before the next heading arrives.
  gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '.teaser', start: 'top bottom', end: () => (innerWidth < 900 ? 'bottom 82%' : 'bottom 38%'), scrub: 1 } })
    .fromTo(u, { horizonY: -.02, sun: 1 }, { horizonY: .15, duration: .62, immediateRender: false }, 0)
    .to(u, { horizonY: -.08, duration: .38 }, .62)
    .to(u, { sun: 0, duration: .24 }, .76);
}

// The film: one clear button, then the browser's own controls.
const film = document.querySelector<HTMLVideoElement>('#filmv');
const play = document.querySelector<HTMLButtonElement>('.film__play');
if (film && play) {
  const started = () => { play.hidden = true; film.controls = true; };
  film.controls = false; play.hidden = false;
  play.addEventListener('click', () => { started(); void film.play(); });
  film.addEventListener('play', started);
}
