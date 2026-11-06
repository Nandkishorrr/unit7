// Real use, Environments and the Map. Everything heavy is built only as it approaches the viewport, so a long Home
// costs nothing until someone gets there. Without motion, the HTML is already the finished page.
import { gsap, ScrollTrigger, MOTION, u, count, slash, speak, wipe } from './motion';

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)!;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];

const STACK = '(min-width: 900px) and (min-height: 660px)';
const mm = gsap.matchMedia();

// Fires when `trigger` gets near; `build` runs once and returns a paused timeline, played when it really arrives.
function lazy(trigger: Element, build: () => gsap.core.Timeline, arrive = 'top 55%') {
  let tl: gsap.core.Timeline | null = null;
  ScrollTrigger.create({ trigger, start: 'top 130%', once: true, onEnter: () => { if (!u.pause) tl = build().pause(); } });
  ScrollTrigger.create({ trigger, start: arrive, once: true, onEnter: () => tl?.play() });
}

// --- A. The six moments -------------------------------------------------------------------------------------------------
if (MOTION) {
  const plays: Record<string, (m: HTMLElement) => gsap.core.Timeline> = {
    own(m) {
      const rows = $$('.own__row', m);
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      gsap.set(rows, { opacity: 0, y: 12 });
      gsap.set($$('.own__wire', m), { scaleX: 0 });
      gsap.set($('.own__foot', m), { opacity: 0 });
      rows.forEach((r, i) => {
        tl.to(r, { opacity: 1, y: 0, duration: .4 }, i * .34);
        const wires = $$('.own__wire', r);
        if (wires.length) tl.to(wires, { scaleX: 1, duration: .32, stagger: .1 }, i * .34 + .1);
      });
      return tl.to($('.own__foot', m), { opacity: 1, duration: .4 }, '-=.1');
    },
    traffic(m) {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      gsap.set($$('.tf__bar', m), { scaleY: 0 });
      gsap.set([$('.tf__deploy', m), $('.tf__band', m)], { opacity: 0 });
      gsap.set($('.tf__mix', m), { scaleX: 0 });
      gsap.set($$('.tf__who i', m), { scaleX: 0 });
      $$<SVGCircleElement>('.ring', m).forEach((r) => gsap.set(r, { attr: { 'stroke-dasharray': '0 100' } }));
      tl.to($('.tf__band', m), { opacity: 1, duration: .5 }, 0)
        .to($$('.tf__bar', m), { scaleY: 1, duration: .6, stagger: .022 }, .05)
        .to($('.tf__deploy', m), { opacity: 1, duration: .3 }, .75)
        .to($('.tf__mix', m), { scaleX: 1, duration: .8 }, .5)
        .to($$('.tf__who i', m), { scaleX: 1, duration: .7, stagger: .1 }, .7);
      $$('[data-count]', m).forEach((el) => tl.add(count(el, { duration: 1.2 }), .3));
      $$<SVGCircleElement>('.ring', m).forEach((r) => {
        tl.to(r, { attr: { 'stroke-dasharray': `${r.style.getPropertyValue('--v')} 100` }, duration: .9 }, .75);
      });
      return tl;
    },
    story(m) {
      const line = $('.sty__line', m), marks = $$('.sty__m', m);
      const tl = gsap.timeline({ defaults: { ease: 'none' } });
      gsap.set(line, { strokeDashoffset: 1 });
      gsap.set(marks, { opacity: 0 });
      gsap.set([$('.sty__say', m), $('.sty__row', m), $('.sty__undo', m)], { opacity: 0, y: 10 });
      tl.to(line, { strokeDashoffset: 0, duration: 1.7 }, 0)
        .to(marks[0], { opacity: 1, duration: .15 }, .4)
        .to(marks[1], { opacity: 1, duration: .15 }, .88)
        .to(marks[2], { opacity: 1, duration: .15 }, 1.34)
        .to([$('.sty__say', m), $('.sty__row', m), $('.sty__undo', m)], { opacity: 1, y: 0, duration: .45, stagger: .14, ease: 'power2.out' }, 1.65);
      return tl;
    },
    feed(m) {
      const rows = $$('.feed__row', m), btn = $('.feed__btn', m), done = $('.feed__done', m), steps = $$('.feed__ladder li', m), small = $('.feed__small', m);
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      gsap.set(rows, { opacity: 0, y: 14 });
      gsap.set(done, { opacity: 0, x: -6 });
      gsap.set([small, $('.feed__ladder', m)], { opacity: 0 });
      rows.forEach((r, i) => {
        tl.to(r, { opacity: 1, y: 0, duration: .42 }, i * .24);
        $$('[data-count]', r).forEach((el) => tl.add(count(el, { duration: 1 }), i * .24 + .08));
      });
      return tl
        .to($('.feed__ladder', m), { opacity: 1, duration: .35 }, 1.5)
        .to(btn, { scale: .94, duration: .13, ease: 'none' }, 2.1)
        .to(btn, { scale: 1, duration: .13, ease: 'none' }, 2.23)
        .to(btn, { opacity: 0, duration: .22, ease: 'none' }, 2.38)
        .to(done, { opacity: 1, x: 0, duration: .32 }, 2.46)
        .call(() => { steps[0].classList.add('on'); if (ScrollTrigger.isInViewport(m, .4)) speak('Blocked. It lifts by itself.'); }, undefined, 2.5)
        .call(() => steps[1].classList.add('on'), undefined, 3.05)
        .call(() => steps[2].classList.add('on'), undefined, 3.5)
        .call(() => steps[3].classList.add('on'), undefined, 3.95)
        .to(small, { opacity: 1, duration: .4 }, 3.2);
    },
    doors(m) {
      const rows = $$('.door__row', m), btn = $('.door__row:nth-child(2) .door__btn', m), done = $('.door__done', m);
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      gsap.set(rows, { opacity: 0, x: -14 });
      gsap.set(done, { opacity: 0 });
      gsap.set([$('.door__foot', m), $('.door__small', m)], { opacity: 0 });
      tl.to(rows, { opacity: 1, x: 0, duration: .36, stagger: .2 }, 0)
        .to([$('.door__foot', m), $('.door__small', m)], { opacity: 1, duration: .4, stagger: .1 }, 1.25)
        .to(btn, { scale: .94, duration: .13, ease: 'none' }, 1.8)
        .to(btn, { scale: 1, duration: .13, ease: 'none' }, 1.93)
        .to(btn, { opacity: 0, duration: .2, ease: 'none' }, 2.06)
        .to(done, { opacity: 1, duration: .3 }, 2.12);
      return tl;
    },
    month(m) {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      gsap.set($('.mon__fill', m), { scaleX: 0 });
      gsap.set($$('.mon__split i', m), { scaleX: 0 });
      gsap.set($('.mon__warn', m), { opacity: 0 });
      gsap.set($('.mon__tip', m), { opacity: 0, y: 12 });
      tl.add(count($('[data-count]', m), { duration: 1.3 }), 0)
        .to($('.mon__fill', m), { scaleX: 1, duration: 1.2 }, 0)
        .to($('.mon__warn', m), { opacity: 1, duration: .3 }, .85)
        .to($$('.mon__split i', m), { scaleX: 1, duration: .7, stagger: .08 }, .55)
        .to($('.mon__tip', m), { opacity: 1, y: 0, duration: .45 }, 1.2);
      return tl;
    },
  };

  const panels = $$('.mo');
  panels.forEach((p) => {
    const mock = $<HTMLElement>('[data-mock]', p), strike = $('.strike', p);
    gsap.set(strike, { '--k': `${strike.offsetHeight * slash}px`, '--s': 0 });
    ScrollTrigger.create({ trigger: p, start: 'top 62%', once: true, onEnter: () => gsap.to(strike, { '--s': 1, duration: .9, ease: 'power2.inOut' }) });
    lazy(p, () => plays[mock.dataset.mock!](mock), 'top 42%');
  });

  // Each panel settles back a little as the next one slides over it.
  mm.add(STACK, () => {
    panels.slice(0, -1).forEach((p, i) => {
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: panels[i + 1], start: 'top bottom', end: 'top top', scrub: true } })
        .to($('.mo__in', p), { scale: .935, '--dim': .62 }, 0);
    });
  });
}

// --- B. Environments --------------------------------------------------------------------------------------------------
{
  const box = $('.envx'), radios = $$<HTMLInputElement>('input[name="env"]');
  let at = 0, auto: gsap.core.Tween | null = null, touched = false, seen = false;
  const show = (i: number) => {
    at = i;
    box.dataset.at = String(i);
    radios[i].checked = true;
    if (MOTION) $$('tbody tr', box).forEach((tr, r) => {
      const td = tr.querySelectorAll('td')[i] as HTMLElement;
      wipe(td, { delay: r * .05, dur: .5, block: true });
    });
  };
  const tick = () => {
    auto?.kill();
    if (touched || !seen || u.pause) return;
    auto = gsap.delayedCall(4.6, () => { show((at + 1) % radios.length); tick(); });
  };
  const stop = () => { touched = true; auto?.kill(); };
  radios.forEach((r, i) => r.addEventListener('change', () => { stop(); show(i); }));
  box.addEventListener('pointerdown', stop);
  box.addEventListener('keydown', stop);
  if (MOTION) ScrollTrigger.create({ trigger: box, start: 'top 70%', end: 'bottom 25%', onToggle: (self) => { seen = self.isActive; seen ? tick() : auto?.kill(); } });
}

// --- C. The Map ---------------------------------------------------------------------------------------------------------
{
  const map = $('.tm__map'), svg = $<SVGSVGElement>('.tm__svg'), log = $('.tm__log');
  const qs = $$<HTMLButtonElement>('.tm__q');
  const WORKS = [['d-nest', 'a-nest'], ['d-nest', 'a-shop'], ['d-ship', 'a-api'], ['d-orbit', 'a-orbit'], ['a-nest', 'b-nest'], ['a-api', 'b-ship'], ['a-work', 'b-ship'], ['a-stag', 'b-stag']];
  const NS = 'http://www.w3.org/2000/svg';
  const node = (id: string) => $(`[data-n="${id}"]`, map);
  const el = (tag: string, cls: string, attrs: Record<string, string> = {}) => {
    const e = document.createElementNS(NS, tag);
    e.setAttribute('class', cls);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const curve = (a: string, b: string) => {
    const m = map.getBoundingClientRect(), r = node(a).getBoundingClientRect(), s = node(b).getBoundingClientRect();
    const x0 = r.right - m.left, y0 = r.top + r.height / 2 - m.top, x1 = s.left - m.left, y1 = s.top + s.height / 2 - m.top, d = Math.max(24, (x1 - x0) * .55);
    return `M${x0} ${y0}C${x0 + d} ${y0} ${x1 - d} ${y1} ${x1} ${y1}`;
  };

  let bad: SVGPathElement, end: SVGCircleElement, fixed: SVGPathElement, wired: SVGPathElement;
  const lines = new Map<string, SVGPathElement>();
  const state = { fixed: false, wired: false };

  const draw = () => {
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${map.offsetWidth} ${map.offsetHeight}`);
    lines.clear();
    WORKS.forEach(([a, b], i) => {
      const d = curve(a, b), p = el('path', 'tm-line', { d }) as SVGPathElement;
      svg.append(p); lines.set(`${a}>${b}`, p);
      if (MOTION) svg.append(el('path', 'tm-pulse', { d, pathLength: '100', style: `--t:${5 + (i % 3) * 1.4}s;--d:${-i * 1.1}s` }));
    });
    // The dashed line leaves its domain and ends in nothing: it points elsewhere.
    const m = map.getBoundingClientRect(), r = node('d-stag').getBoundingClientRect(), s = node('a-api').getBoundingClientRect();
    const x0 = r.right - m.left, y0 = r.top + r.height / 2 - m.top, x1 = x0 + (s.left - r.right) * .62, y1 = y0 + r.height * 1.1;
    bad = el('path', 'tm-line bad', { d: `M${x0} ${y0}C${x0 + 20} ${y0} ${x1 - 18} ${y1} ${x1} ${y1}` }) as SVGPathElement;
    end = el('circle', 'tm-end', { cx: String(x1 + 4), cy: String(y1), r: '4' }) as SVGCircleElement;
    fixed = el('path', 'tm-draw', { d: curve('d-stag', 'a-stag'), pathLength: '1' }) as SVGPathElement;
    wired = el('path', 'tm-draw', { d: curve('a-orbit', 'b-orbit'), pathLength: '1' }) as SVGPathElement;
    svg.append(bad, end, fixed, wired);
    apply();
  };
  // Whatever has happened so far, shown without animation. Also what a resize comes back to.
  const apply = () => {
    bad.style.opacity = end.style.opacity = state.fixed ? '0' : '1';
    fixed.style.strokeDashoffset = state.fixed ? '0' : '1';
    wired.style.strokeDashoffset = state.wired ? '0' : '1';
  };
  const calm = () => {
    $$('.amber, .hot, .miss', map).forEach((n) => n.classList.remove('amber', 'hot', 'miss'));
    lines.forEach((l) => l.classList.remove('amber'));
    bad?.classList.remove('glow');
  };

  const fx = {
    look: () => { bad.classList.add('glow'); node('d-stag').classList.add('hot'); },
    fix: () => {
      state.fixed = true; bad.classList.remove('glow'); node('d-stag').classList.remove('hot');
      if (!MOTION) return apply();
      gsap.to([bad, end], { opacity: 0, duration: .35 });
      gsap.to(fixed, { strokeDashoffset: 0, duration: .8, ease: 'power2.inOut' });
    },
    missing: () => node('a-orbit').classList.add('miss'),
    connect: () => {
      state.wired = true; node('a-orbit').classList.remove('miss');
      if (!MOTION) return apply();
      gsap.to(wired, { strokeDashoffset: 0, duration: .9, ease: 'power2.inOut' });
    },
    delete: () => {
      ['b-ship', 'a-api', 'a-work'].forEach((n) => node(n).classList.add('amber'));
      lines.get('a-api>b-ship')?.classList.add('amber'); lines.get('a-work>b-ship')?.classList.add('amber');
    },
  };

  let tl: gsap.core.Timeline | null = null, auto = true, active = -1, next: gsap.core.Tween | null = null, seen = false;
  const after = (i: number) => {       // the conversation so far: each question leaves the map as it left it
    state.fixed = i > 0; state.wired = i > 2;
    apply();
  };
  const ask = (i: number) => {
    tl?.kill(); next?.kill(); calm(); after(i);
    active = i;
    qs.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
    const li = qs[i].closest('li')!, kind = qs[i].dataset.fx as 'look' | 'missing' | 'connect' | 'delete';
    const question = qs[i].textContent!, answer = $('.tm__a', li).textContent!, yes = li.querySelector('.tm__yes')?.textContent;
    log.replaceChildren();
    const ub = document.createElement('p'); ub.className = 'tm__ub';
    const ans = document.createElement('p'); ans.className = 'tm__ans';
    answer.split(/(\s+)/).forEach((w) => { if (/^\s+$/.test(w)) ans.append(w); else if (w) { const s = document.createElement('span'); s.className = 'w'; s.textContent = w; ans.append(s); } });
    log.append(ub, ans);
    const words = $$('.w', ans);
    const go = yes ? Object.assign(document.createElement('button'), { className: 'tm__go', type: 'button', textContent: yes }) : null;
    const press = () => { go?.remove(); fx.fix(); };
    if (go) go.addEventListener('click', () => { auto = false; press(); });

    if (!MOTION) {
      ub.textContent = question; words.forEach((w) => { w.style.opacity = '1'; });
      fx[kind]();
      if (go) ans.after(go);
      return;
    }
    const typing = { n: 0 };
    tl = gsap.timeline({ defaults: { ease: 'none' } })
      .to(typing, { n: question.length, duration: Math.min(1.1, question.length * .028), onUpdate: () => { ub.textContent = question.slice(0, Math.round(typing.n)); } })
      .call(fx[kind], undefined, '+=.2')
      .to(words, { opacity: 1, duration: .1, stagger: .032 }, '+=.25');
    if (go) tl.call(() => ans.after(go));
    tl.call(() => {
      if (!auto || !seen) return;
      next = gsap.delayedCall(go ? 1.5 : 3.2, () => {
        if (go) { go.classList.add('press'); gsap.delayedCall(.2, () => { press(); next = gsap.delayedCall(2.4, () => ask((i + 1) % qs.length)) as unknown as gsap.core.Tween; }); }
        else ask((i + 1) % qs.length);
      }) as unknown as gsap.core.Tween;
    });
  };

  qs.forEach((b, i) => b.addEventListener('click', () => { auto = false; ask(i); }));

  // Lines are only measured and drawn when the Map gets close, and again if its size changes.
  let ready = false;
  const init = () => {
    if (ready) return;
    ready = true;
    draw();
    new ResizeObserver(() => draw()).observe(map);
    if (!MOTION) ask(0);
  };
  ScrollTrigger.create({ trigger: map, start: 'top 140%', once: true, onEnter: init });
  if (!MOTION) init();
  if (MOTION) ScrollTrigger.create({
    trigger: map, start: 'top 62%', end: 'bottom 22%',
    onToggle: (self) => {
      seen = self.isActive;
      if (seen && auto) ask(active < 0 ? 0 : (active + 1) % qs.length);
      else if (!seen) { tl?.pause(); next?.kill(); }
    },
  });
}
