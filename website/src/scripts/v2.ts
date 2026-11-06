// V2. Dawn. As on Home, the page is complete without this; it only adds the motion.
import { gsap, ScrollTrigger, MOTION, u, count, hush, pageIntro, slash } from './motion';

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)!;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];

pageIntro();

if (MOTION) {
  const mm = gsap.matchMedia();
  const DESK = '(min-width: 900px)';

  // The horizon rises a little under the hero's text, then sets before the next section arrives, so it never crosses
  // content. The closing section brings it back up.
  gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '.vh', start: 'top top', end: () => (innerWidth < 900 ? 'bottom 80%' : 'bottom 42%'), scrub: 1 } })
    .fromTo(u, { horizonY: .05 }, { horizonY: .13, duration: .5 }, 0)
    .to(u, { horizonY: -.08, duration: .5 }, .5)
    .to(u, { sun: 0, duration: .3 }, .7);
  gsap.fromTo(u, { horizonY: .02, sun: 0 }, { horizonY: .24, sun: 1, ease: 'none', immediateRender: false, scrollTrigger: { trigger: '.vc', start: 'top bottom', end: 'bottom bottom', scrub: 1 } });

  // Today and in V2: each line is struck, and the new one wipes in beside it.
  mm.add(DESK, () => {
    $$('.vt__row').forEach((row) => {
      const next = $('.vt__next', row), slashEl = $('.vt__slash', row), txt = $('.vt__txt', row);
      const k = next.offsetHeight * slash;
      gsap.set(next, { '--k': `${k}px`, '--p': 0 });
      next.style.clipPath = 'polygon(0 -10%, calc((100% + var(--k)) * var(--p)) -10%, calc((100% + var(--k)) * var(--p) - var(--k)) 110%, 0 110%)';
      gsap.set(slashEl, { '--f': 0 });
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: row, start: 'top 84%', end: 'top 56%', scrub: .6 } })
        .to(txt, { '--s': 1, duration: .5 }, 0)
        .to(slashEl, { '--f': 1, duration: .2 }, .34)
        .to(next, { '--p': 1, duration: .45 }, .46);
    });
  });

  // Safety Net: the ladder ticks through, and the meter fills up the leaning bars as each level is earned.
  mm.add(DESK, () => {
    const steps = $$('.ladder li'), bars = $$('.meter li'), fills = $$('.meter__bar i'), says = $('.net__says');
    gsap.set(steps, { opacity: .3 });
    gsap.set(bars.slice(1), { opacity: .42 });
    gsap.set(fills, { '--f': '0%' });
    gsap.set(fills[0], { '--f': '100%' });
    gsap.set(says, { opacity: 0, y: 14 });
    const tl = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '.net', start: 'top top', end: 'bottom bottom', scrub: .7 } });
    const levelAt = [1, 3, 6];   // Weak after the copy is checked, Protected once it's off the server, Proven after the test restore
    steps.forEach((li, i) => {
      tl.to(li, { opacity: 1, duration: .5 }, i * .7);
      const lvl = levelAt.indexOf(i) + 1;
      if (lvl) {
        tl.to(bars[lvl], { opacity: 1, duration: .4 }, i * .7)
          .to(fills[lvl], { '--f': '100%', duration: .7 }, i * .7);
      }
    });
    tl.to(says, { opacity: 1, y: 0, duration: .5 }, 7 * .7).call(hush, undefined, 7 * .7).to({}, { duration: .7 });
  });

  // The bands arrive one at a time. Check-up's numbers count up as it enters.
  ScrollTrigger.create({
    trigger: '.cum', start: 'top 70%', once: true,
    onEnter: () => $$('.cum [data-count]').forEach((el, i) => { if (!u.pause) count(el, { delay: i * .06, duration: 1.1 }); }),
  });

  // The rail lights up in order. The second branch only shows at the end.
  {
    const rail = $$('.rail li');
    gsap.set(rail.slice(0, 4), { opacity: .28, '--f': 0 });
    gsap.set(rail[4], { opacity: 0, '--f': 0 });
    const tl = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '.rail', start: 'top 80%', end: 'top 34%', scrub: .6 } });
    rail.slice(0, 4).forEach((li, i) => {
      tl.to(li, { opacity: 1, duration: .25 }, i * .7);
      if (i < 3) tl.to(li, { '--f': 1, duration: .5 }, i * .7 + .15);
    });
    tl.to(rail[4], { opacity: 1, '--f': 1, duration: .5 }, 2.2);
  }

  // Call Inspector: the same line, again and again, then one row and a counter.
  {
    const lines = $$('.logs__stream code'), one = $('.logs__one'), counter = $('.logs__count');
    const stream = $('.logs__stream');
    gsap.set(lines, { opacity: 0, y: 8 });
    gsap.set(one, { height: 0, opacity: 0, overflow: 'hidden' });
    ScrollTrigger.create({
      trigger: '.logs', start: 'top 68%', once: true,
      onEnter: () => {
        if (u.pause) { gsap.set(lines, { opacity: 1, y: 0 }); gsap.set(one, { height: 'auto', opacity: 1 }); return; }
        const n = { v: 0 };
        counter.textContent = '0';
        gsap.timeline()
          .to(lines, { opacity: 1, y: 0, duration: .18, stagger: .09, ease: 'none' })
          .to(lines, { opacity: .35, duration: .3 }, '+=.15')
          .to(stream, { height: 0, opacity: 0, duration: .55, ease: 'power3.inOut' }, '+=.1')
          .to(one, { height: 'auto', opacity: 1, duration: .55, ease: 'power3.inOut' }, '<')
          .to(n, { v: 6625, duration: 1.5, ease: 'power2.out', onUpdate() { counter.textContent = Math.round(n.v).toLocaleString('en-US'); } }, '-=.1');
      },
    });
  }

  // Always on: lime fills the gaps as you scroll, and the readout climbs from what was measured to the target.
  {
    const gaps = $$('.on__week .gap'), pct = $('.on__pct'), tag = $('.on__tag');
    // Two hours stay dark: 166 of 168 is the 99% we're aiming for, not a perfect 100.
    const fill = gaps.slice(0, -2).sort((a, b) => (a.dataset.o = a.dataset.o ?? String(Math.random()), b.dataset.o = b.dataset.o ?? String(Math.random()), +a.dataset.o - +b.dataset.o));
    const s = { v: 58 };
    gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: '.on__week', start: 'top 82%', end: 'top 26%', scrub: .7 },
    })
      .to(fill, { backgroundColor: '#C6F432', duration: .06, stagger: 1 / fill.length }, 0)
      .to(s, {
        v: 99, duration: 1,
        onUpdate() {
          pct.textContent = String(Math.round(s.v));
          tag.textContent = s.v <= 58.5 ? 'measured' : s.v >= 98.5 ? 'the target' : '\u00a0';
        },
      }, 0);
  }
}
