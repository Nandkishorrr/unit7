// The film: chaos becomes order. One paused GSAP timeline; a frame is a seek, so any frame renders the same on any run.
(async () => {
  await document.fonts.ready;
  await Promise.all(['760 40px Archivo', 'italic 760 40px Archivo', '500 40px Geist', '500 40px "JetBrains Mono"'].map((f) => document.fonts.load(f)));

  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const { u, MOODS } = Shader;
  const dpr = +new URLSearchParams(location.search).get('dpr') || 1;
  const draw = Shader.start($('#gl'), dpr);

  // --- Time. The cut follows the music: 124 BPM, so a bar is 1.935s. src/grid.py checks it. ----------------------
  const FPS = 60, LEN = 60;
  const BAR = 240 / 124, b = (n) => n * BAR;
  const CUT = { s1: b(4), s2: b(7), s3: b(12.5), s4: b(16.5), s5: b(19), s6: b(21.5), s7: b(23.5), s8: b(26), s9: b(28.5), s10: b(29.5) };
  const VO = { hook1: .5, hook2: b(2), meet: CUT.s1 + .06, runs: b(5), ask: b(7.5), yours: 18.0, risky: 20.32, conn1: b(12.75), conn2: b(14.5), srv: b(17), app: b(19.25), env: b(21.75), sev: b(23.75), end1: b(26.25), end2: b(27.25), os: CUT.s9 + .1 };
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const on = (line, word, nth = 0) => {           // when a word is spoken, so a picture can land on it
    const hits = WORDS[line].filter(([w]) => clean(w).startsWith(clean(word)));
    if (!hits[nth]) throw new Error(`no word "${word}" in ${line}`);
    return VO[line] + hits[nth][1];
  };
  const sounds = [];
  const sfx = (name, t, gain = 1) => sounds.push({ name, t: +t.toFixed(3), gain });

  gsap.defaults({ ease: 'power3.out' });
  CustomEase.create('snap', '0.7,0,0.15,1');
  const tl = gsap.timeline({ paused: true });

  // --- Helpers --------------------------------------------------------------------------------------------------
  function split(el) {
    const walk = (n) => [...n.childNodes].forEach((c) => {
      if (c.nodeType !== 3) return void (c.nodeName !== 'BR' && walk(c));
      const f = document.createDocumentFragment();
      c.textContent.split(/(\s+)/).forEach((p) => {
        if (!p) return;
        if (/^\s+$/.test(p)) return f.append(' ');
        const w = document.createElement('span'); w.className = 'w';
        const i = document.createElement('span'); i.className = 'wi'; i.textContent = p;
        w.append(i); f.append(w);
      });
      n.replaceChild(f, c);
    });
    walk(el); return [...el.querySelectorAll('.wi')];
  }
  const rise = (el, t, o = {}) => { const ws = el._w ?? (el._w = split(el)); tl.fromTo(ws, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: o.dur ?? .8, ease: 'expo.out', stagger: o.stagger ?? .06 }, t); };
  const sink = (el, t, o = {}) => tl.to(el._w, { yPercent: -150, duration: o.dur ?? .36, ease: 'power3.in', stagger: o.stagger ?? .012 }, t);
  const appear = (el, t, o = {}) => tl.fromTo(el, { autoAlpha: 0, y: o.y ?? 36 }, { autoAlpha: 1, y: 0, duration: o.dur ?? .7, ease: 'expo.out', stagger: o.stagger }, t);
  const type = (el, text, t, cps = 34, clearAt) => {
    const s = { n: 0 }, show = () => { el.textContent = text.slice(0, Math.round(s.n)); };
    tl.to(s, { n: text.length, duration: text.length / cps, ease: 'none', onUpdate: show }, t);
    if (clearAt) tl.to(s, { n: 0, duration: .01, ease: 'none', onUpdate: show }, clearAt);
    return text.length / cps;
  };
  const mood = (name, t, dur = 1, intensity) => {
    const m = MOODS[name];
    tl.to(u.pal, { endArray: m.pal, duration: dur, ease: 'power2.inOut' }, t);
    tl.to(u, { intensity: intensity ?? m.intensity, horizon: m.horizon, day: m.day, duration: dur, ease: 'power2.inOut' }, t);
  };
  const scene = (sel, from, to) => { tl.set(sel, { visibility: 'visible' }, from); tl.set(sel, { visibility: 'hidden' }, to); };
  const sweep = (t, dur = .62) => {
    sfx('whoosh', t - .2, .8);
    for (const [s, d] of [['#sw1', 0], ['#sw2', .07]]) tl.fromTo(s, { x: 0 }, { x: 6000, duration: dur, ease: 'snap', immediateRender: false }, t - dur / 2 + d);
  };
  // the signature move: a small 7 races at the camera and we fly through it into the next scene
  const gate = (t, name) => {
    sfx('whoosh', t - .42, 1);
    tl.set(u, { fx: 11.4, fy: 15.6, sx: 960, sy: 540, unit: 16, mark: 0, bar: 1, stroke: 1, glint: 46 }, t - .74);
    tl.fromTo(u, { mark: 0 }, { mark: 1, duration: .12, ease: 'none', immediateRender: false }, t - .73);
    tl.fromTo(u, { zoom: .5 }, { zoom: 60, duration: .73, ease: 'power4.in', immediateRender: false }, t - .73);
    tl.set(u, { mark: 0, zoom: 1 }, t + .01);
    if (name) mood(name, t - .3, .7);
  };
  const leaveScene = (sel, t) => tl.to(sel, { scale: .86, autoAlpha: 0, duration: .34, ease: 'power3.in' }, t);
  const enterScene = (sel, t) => tl.fromTo(sel, { scale: .7 }, { scale: 1, duration: 1, ease: 'expo.out' }, t);

  const TICK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M3.5 8.5 6.6 11.6 12.5 5"/></svg>';
  const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
  const KEY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5.5" cy="10.5" r="3"/><path d="m8 8 5-5m-2 2 2 2"/></svg>';
  const logo = (k, size) => {
    const l = LOGOS[k], s = size / Math.max(l.w, l.h);
    return `<svg viewBox="0 0 ${l.w} ${l.h}" width="${Math.round(l.w * s)}" height="${Math.round(l.h * s)}" fill="currentColor" style="color:#F2F2F4">${l.body}</svg>`;
  };
  const tile = (k, size, cls = 'tile') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = logo(k, size); if (k === 'mysql' || k === 'heroku') d.firstChild.style.filter = 'brightness(3) saturate(1.3)'; return d; };
  let seed = 77;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  const ALL = ['hostinger', 'cloudflare', 'vercel', 'netlify', 'render', 'railway', 'fly', 'coolify', 'docker', 'digitalocean', 'hetzner', 'aws', 'gcp', 'azure', 'firebase', 'heroku', 'supabase', 'neon', 'postgres', 'mysql', 'redis', 'mongodb', 'github', 'openai'];

  // --- S0: your AI wrote the code, and then all of this -----------------------------------------------------------
  scene('#s0', 0, CUT.s1 + .1);
  mood('alert', 0, 2, .95);
  rise($('#hk1'), VO.hook1, { stagger: .17, dur: .8 });
  sink($('#hk1'), VO.hook1 + 1.75);
  const pile = ALL.map((k) => tile(k, 84));
  ['502 Bad Gateway', 'disk 96% full', 'SSL expired', 'backup failed', 'DNS not found', '.env'].forEach((e) => { const d = document.createElement('div'); d.className = 'err'; d.textContent = e; pile.push(d); });
  // scattered on a loose grid so it fills the frame, then shuffled so it arrives in no order
  const COLS = 6, ROWS = 5;
  const places = pile.map((_, i) => [rnd(), i]).sort((a, c) => a[0] - c[0]).map((p) => p[1]);
  pile.forEach((el, n) => {
    const i = places[n], x = (i % COLS + .5) * 1920 / COLS + (rnd() - .5) * 190, y = (Math.floor(i / COLS) + .5) * 1080 / ROWS + (rnd() - .5) * 130;
    el.style.left = `${x - 66}px`; el.style.top = `${y - 60}px`; $('#chaos').append(el);
  });
  const order = pile.map((el) => [rnd(), el]).sort((a, c) => a[0] - c[0]).map((p) => p[1]);
  const tPile = VO.hook1 + 1.9;
  order.forEach((el, i) => {
    const t = tPile + i * (b(4) - .6 - tPile) * .62 / order.length;
    tl.fromTo(el, { scale: 0, rotate: (rnd() - .5) * 70 }, { scale: 1.1 + rnd() * .45, rotate: (rnd() - .5) * 22, duration: .42, ease: 'back.out(2.2)' }, t);
    tl.to(el, { x: `+=${(rnd() - .5) * 60}`, y: `+=${(rnd() - .5) * 50}`, duration: 3, ease: 'sine.inOut' }, t + .3);
    if (i % 2 === 0) sfx('tick', t, .42);
  });
  rise($('#hk2'), VO.hook2 - .02, { stagger: .1, dur: .7 });
  tl.fromTo('#chaos', { opacity: 1, filter: 'blur(0px) brightness(1)' }, { opacity: .8, filter: 'blur(4px) brightness(.42)', duration: .5, ease: 'power2.out' }, VO.hook2 - .05);
  // everything is pulled to one point, and that point becomes the 7
  const tSuck = CUT.s1 - .62;
  sink($('#hk2'), tSuck - .1, { dur: .3, stagger: .01 });
  tl.to('#chaos', { opacity: 1, filter: 'blur(0px) brightness(1)', duration: .3, ease: 'power2.in' }, tSuck - .2);
  pile.forEach((el) => {
    const r = { x: parseFloat(el.style.left) + 60, y: parseFloat(el.style.top) + 60 };
    tl.to(el, { x: 960 - r.x, y: 500 - r.y, scale: .05, rotate: 180 * (rnd() - .5), autoAlpha: 0, duration: .56, ease: 'power3.in' }, tSuck + rnd() * .06);
  });
  sfx('rise', tSuck - .7, .9);

  // --- S1: the 7 rides down --------------------------------------------------------------------------------------
  scene('#s1', CUT.s1, CUT.s2);
  const kick = CUT.s1;
  mood('night', kick - .3, .5, 1);
  tl.set(u, { fx: 16, fy: 16, sx: 960, sy: 470, unit: 30, zoom: 1, mark: 1, bar: 0, stroke: 0, glint: -5 }, kick - .02);
  tl.fromTo(u, { bar: 0 }, { bar: 1, duration: .5, ease: 'expo.out', immediateRender: false }, kick);
  tl.fromTo(u, { stroke: 0 }, { stroke: 1, duration: .75, ease: 'power3.out', immediateRender: false }, kick + .1);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.1, ease: 'power2.out', immediateRender: false }, kick + .12);
  tl.fromTo(u, { swirl: .6 }, { swirl: 0, duration: 1.4, ease: 'power2.out', immediateRender: false }, kick);
  sfx('boom', kick, 1);
  rise($('#wm'), on('meet', 'Unit') - .1, { dur: .7 });
  sink($('#wm'), VO.runs - .32, { dur: .3 });
  tl.to(u, { sx: 1500, sy: 560, unit: 52, duration: 1.05, ease: 'expo.inOut' }, VO.runs - .36);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.1, ease: 'power2.out', immediateRender: false }, VO.runs + .2);
  [['#b1', 'servers'], ['#b2', 'apps'], ['#b3', 'domains']].forEach(([s, w]) => { rise($(s), on('runs', w) - .06, { dur: .7 }); sfx('pop', on('runs', w) - .02, .7); });
  const thru = CUT.s2 - .98;
  ['#b1', '#b2', '#b3'].forEach((s) => sink($(s), thru - .2, { dur: .3 }));
  tl.to(u, { fx: 11.4, fy: 15.6, sx: 960, sy: 540, duration: .6, ease: 'power3.inOut' }, thru);
  tl.to(u, { zoom: 46, duration: .98, ease: 'power4.in' }, thru + .02);
  tl.set(u, { mark: 0, zoom: 1 }, CUT.s2 + .02);
  sfx('whoosh', thru + .3, 1);

  // --- S2: the AI. A sentence goes in, the work comes out -----------------------------------------------------------
  scene('#s2', CUT.s2, CUT.s3 + .02);
  mood('night', CUT.s2 - .2, .6, .8);
  enterScene('#ask', CUT.s2);
  tl.fromTo('#ask', { autoAlpha: 0 }, { autoAlpha: 1, duration: .4 }, CUT.s2);
  rise($('#ja'), on('ask', 'just') - .04, { stagger: .1 });
  tl.fromTo('#caret', { opacity: 1 }, { opacity: 0, duration: .22, ease: 'steps(1)', repeat: 8, yoyo: true }, CUT.s2 + .4);
  const talk = [['Put my app online', 'Live at nestly.example', 14.1], ['Add a database', 'Postgres added and wired in', 15.4], ['Why is my site slow?', 'Found it: one slow query', 16.65]];
  const rs = talk.map(([p, r, t], i) => {
    const next = talk[i + 1]?.[2] ?? VO.yours + .3;
    const d = type($('#asktext').appendChild(document.createElement('span')), p, t, 30, next - .25);
    for (let k = 0; k < 6; k++) sfx('key', t + k * d / 6, .3);
    const res = document.createElement('div'); res.className = 'r'; res.innerHTML = `${TICK}<span>${r}</span>`; $('#res').append(res);
    const done = t + d + .22;
    tl.fromTo('#send', { scale: 1 }, { scale: .86, duration: .08, yoyo: true, repeat: 1, ease: 'power2.out', immediateRender: false }, t + d + .04);
    sfx('send', t + d + .04, .5);
    tl.fromTo(res, { autoAlpha: 0, y: 26 }, { autoAlpha: 1, y: 0, duration: .36, ease: 'expo.out' }, done);
    sfx('pop', done, .8);
    tl.to(res, { autoAlpha: 0, y: -14, duration: .18, ease: 'power2.in' }, next - .2);
    return res;
  });
  // the AI you already use plugs in underneath
  const agents = ['claude', 'cursor', 'codex', 'windsurf', 'antigravity', 'openai'];
  agents.forEach((k, i) => {
    const el = tile(k, 74); el.style.left = `${960 + (i - 2.5) * 176 - 66}px`; $('#ais').append(el);
    const t = on('yours', 'plug') + i * .1;
    tl.fromTo(el, { autoAlpha: 0, y: 70, scale: .6 }, { autoAlpha: 1, y: 0, scale: 1, duration: .55, ease: 'back.out(1.8)' }, t);
    sfx('tick', t, .5);
  });
  // ... and it stops to ask
  const tAsk = on('risky', 'asks') - .3;
  tl.to(['#ask', '#ais', '#ja'], { autoAlpha: 0, y: -60, duration: .3, ease: 'power3.in' }, tAsk - .32);
  tl.fromTo('#appr', { autoAlpha: 0, y: 70, scale: .9 }, { autoAlpha: 1, y: 0, scale: 1, duration: .7, ease: 'expo.out' }, tAsk);
  sfx('card', tAsk, .9);
  const tApprove = VO.risky + 2.72;

  // --- S3: connect. Dozens of apps, then one app with many accounts ---------------------------------------------------
  scene('#s3', CUT.s3, CUT.s4 + .02);
  gate(CUT.s3, 'safe');
  tl.to('#appr', { autoAlpha: 0, scale: .9, duration: .28, ease: 'power3.in' }, CUT.s3 - .74);
  const TW = 168, GAP = 26, cols = 8, rowsN = 3;
  const wallTiles = ALL.map((k, i) => {
    const el = tile(k, 96), c = i % cols, r = Math.floor(i / cols);
    const x = 960 + (c - (cols - 1) / 2) * (TW + GAP), y = 540 + (r - (rowsN - 1) / 2) * (TW + GAP);
    el.style.left = `${x - TW / 2}px`; el.style.top = `${y - TW / 2}px`; $('#wall').append(el); el._d = Math.hypot(x - 960, (y - 540) * 1.4); el._x = x; el._y = y; return el;
  });
  wallTiles.forEach((el) => {
    const t = CUT.s3 + .05 + el._d / 1100;
    tl.fromTo(el, { scale: 0, rotate: -14 }, { scale: 1, rotate: 0, duration: .6, ease: 'back.out(1.9)' }, t);
  });
  for (let i = 0; i < 8; i++) sfx('tick', CUT.s3 + .08 + i * .1, .46);
  // a band of light crosses the wall at the 7's angle: all of it, connected
  const tLit = on('conn1', 'dozens') + .3;
  wallTiles.forEach((el) => {
    const t = tLit + (el._x + el._y * .62) / 1900;
    tl.to(el, { boxShadow: 'inset 0 0 0 2.5px rgba(198,244,50,.95), 0 0 46px -6px rgba(198,244,50,.6)', duration: .22 }, t);
    tl.to(el, { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14), 0 30px 50px -24px rgba(0,0,0,.8)', duration: .6 }, t + .3);
  });
  sfx('scan', tLit, .8);
  // into one tile, and it opens into accounts
  const tAcc = VO.conn2 - .5;
  const pickT = wallTiles[2];
  tl.to(wallTiles.filter((e) => e !== pickT), { autoAlpha: 0, scale: .8, duration: .34, ease: 'power3.in', stagger: .004 }, tAcc);
  tl.to(pickT, { x: 370 - pickT._x, y: 540 - pickT._y, scale: 260 / 168, duration: .62, ease: 'expo.inOut' }, tAcc);
  const accs = [['P', 'Personal'], ['A', 'Client A'], ['B', 'Client B']];
  const rowY = [226, 386, 546, 706], rowX = (y) => 1000 - (y - 226) * .22;
  const paths = [];
  [...accs, ['+', 'Add another']].forEach(([l, n], i) => {
    const d = document.createElement('div'); d.className = `acct${i === 3 ? ' add' : ''}`;
    d.innerHTML = `<i>${l}</i><span>${n}</span>${i === 3 ? '' : TICK}`;
    d.style.left = `${rowX(rowY[i])}px`; d.style.top = `${rowY[i]}px`; $('#acctlist').append(d);
    const t = on('conn2', 'as') + .04 + i * .2;
    tl.fromTo(d, { autoAlpha: 0, x: -90 }, { autoAlpha: 1, x: 0, duration: .55, ease: 'expo.out' }, t);
    const y = rowY[i] + 59, x = rowX(rowY[i]);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M500 540 C680 540 ${x - 200} ${y} ${x} ${y}`); p.setAttribute('fill', 'none'); p.setAttribute('stroke', i === 3 ? 'rgba(255,255,255,.2)' : '#C6F432'); p.setAttribute('stroke-width', '3'); p.setAttribute('pathLength', '1');
    p.style.strokeDasharray = '1'; $('#acclines').append(p);
    tl.fromTo(p, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: .42, ease: 'power2.out' }, t - .1);
    sfx('pop', t, .7);
    paths.push(p);
  });

  // --- S4: servers ----------------------------------------------------------------------------------------------------
  scene('#s4', CUT.s4, CUT.s5 + .02);
  tl.to('#acc, #wall', { autoAlpha: 0, scale: .86, duration: .32, ease: 'power3.in' }, CUT.s4 - .74);
  gate(CUT.s4, 'deep');
  rise($('#st h2'), VO.srv - .3, { stagger: .12 });
  appear($('#vps'), VO.srv + .3);
  const gauges = [['CPU', 34], ['Memory', 61], ['Disk', 48]];
  gauges.forEach(([n, v], i) => {
    const d = document.createElement('div'); d.className = 'ring'; d.style.left = `${i * 360}px`;
    d.innerHTML = `<svg viewBox="0 0 320 320" fill="none"><circle cx="160" cy="160" r="146" stroke="rgba(255,255,255,.1)" stroke-width="22"/><circle class="arc" cx="160" cy="160" r="146" stroke="#3D73FF" stroke-width="22" stroke-linecap="round" pathLength="100" stroke-dasharray="100"/></svg><b class="num"><u style="text-decoration:none">0</u><small>%</small></b><span>${n}</span>`;
    $('#rings').append(d);
    const t = CUT.s4 + .2 + i * .14, n_ = { v: 0 }, out = d.querySelector('u');
    tl.fromTo(d, { autoAlpha: 0, scale: .8 }, { autoAlpha: 1, scale: 1, duration: .6, ease: 'expo.out' }, t);
    tl.fromTo(d.querySelector('.arc'), { strokeDashoffset: 100 }, { strokeDashoffset: 100 - v, duration: 1.1, ease: 'expo.out' }, t + .1);
    tl.to(n_, { v, duration: 1.1, ease: 'expo.out', onUpdate() { out.textContent = Math.round(n_.v); } }, t + .1);
    sfx('tick', t, .5);
  });
  [['nestly', null], ['shipfast', null], ['supabase', 'Supabase'], ['coolify', 'Coolify']].forEach(([k, n], i) => {
    const d = document.createElement('div'); d.className = 'ru';
    d.innerHTML = `${n ? logo(k, 54) : '<span style="display:grid;place-items:center;width:54px;height:54px;border-radius:14px;background:#2F66FF;font:700 30px/1 Geist">' + k[0].toUpperCase() + '</span>'}<span>${n ?? k}</span><i></i>`;
    $('#running').append(d);
    const t = on('srv', 'everything') + i * .14;
    tl.fromTo(d, { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: .55, ease: 'expo.out' }, t);
    sfx('pop', t, .55);
  });

  // --- S5: apps -------------------------------------------------------------------------------------------------------
  scene('#s5', CUT.s5, CUT.s6 + .02);
  sweep(CUT.s5);
  mood('night', CUT.s5 - .2, .5, .75);
  const ICON = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    re: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7L20 9M20 4v5h-5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 5 5"/></svg>',
  };
  const btnEls = ['up', 're', 'back'].map((k) => { const d = document.createElement('div'); d.className = 'bt'; d.innerHTML = ICON[k]; $('#btns').append(d); return d; });
  tl.fromTo('#verbs', { autoAlpha: 1 }, { autoAlpha: 1, duration: .01 }, CUT.s5);
  tl.fromTo('#appc', { autoAlpha: 0, x: 80, scale: .95 }, { autoAlpha: 1, x: 0, scale: 1, duration: .8, ease: 'expo.out' }, CUT.s5 + .1);
  const verbs = $$('#verbs p'), ver = $('#ver'), stt = $('#appstt'), st = $('#appst');
  const setText = (el, a, c, t) => { const s = { v: 0 }, f = () => { el.textContent = s.v > .5 ? c : a; }; tl.to(s, { v: 1, duration: .01, ease: 'none', onUpdate: f }, t); };
  const act = (i, t) => {
    tl.to(verbs[i], { color: '#C6F432', duration: .14 }, t);
    tl.to(verbs[i], { color: 'rgba(242,242,244,.6)', duration: .3 }, t + .62);
    tl.to(btnEls[i], { background: '#C6F432', color: '#0E0E12', scale: .94, duration: .1 }, t);
    tl.to(btnEls[i], { background: '#222228', color: '#F2F2F4', scale: 1, duration: .3 }, t + .34);
    sfx('click', t, .9);
  };
  const tDep = on('app', 'deploy'), tRe = on('app', 'restart'), tBack = on('app', 'roll');
  act(0, tDep);
  tl.fromTo('#vbar i', { scaleX: 0 }, { scaleX: 1, duration: .5, ease: 'power2.inOut' }, tDep);
  setText(ver, 'v42', 'v43', tDep + .48); sfx('pop', tDep + .48, .8);
  tl.fromTo(ver, { scale: 1 }, { scale: 1.05, duration: .1, yoyo: true, repeat: 1, ease: 'power2.out', transformOrigin: '0 50%', immediateRender: false }, tDep + .48);
  act(1, tRe);
  tl.fromTo(btnEls[1].querySelector('svg'), { rotate: 0 }, { rotate: 360, duration: .7, ease: 'power2.inOut' }, tRe);
  setText(stt, 'Live', 'Restarting', tRe); setText(stt, 'Live', 'Live', tRe + .62);
  tl.to(st, { color: '#FBBF24', duration: .1 }, tRe);
  tl.to(st, { color: '#4ADE80', duration: .1 }, tRe + .62);
  act(2, tBack);
  tl.to('#vbar i', { scaleX: 0, duration: .46, ease: 'power2.inOut' }, tBack);
  setText(ver, 'v43', 'v42', tBack + .42); sfx('pop', tBack + .42, .8);
  tl.to(verbs, { color: '#F2F2F4', duration: .3 }, on('app', 'one'));

  // --- S6: env --------------------------------------------------------------------------------------------------------
  scene('#s6', CUT.s6, CUT.s7 + .02);
  sweep(CUT.s6);
  mood('deep', CUT.s6 - .2, .5, .9);
  rise($('#ev'), on('env', 'every') - .08, { stagger: .1 });
  tl.fromTo('#envcard', { autoAlpha: 0, y: 90 }, { autoAlpha: 1, y: 0, duration: .8, ease: 'expo.out' }, CUT.s6 + .1);
  const rowsD = [['DATABASE_URL', ['postgres://app:hunter2@db', 'postgres://app:hunter2@db-staging', 'postgres://app:hunter2@db-dev']], ['STRIPE_KEY', ['sk_live_4f9a7c', 'sk_test_b01e22', 'sk_test_b01e22']], ['JWT_SECRET', ['correct-horse-battery', 'correct-horse-battery', 'correct-horse-battery']]];
  rowsD.forEach(([k, vals]) => {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<div class="ic">${KEY}<div class="on">${LOCK}</div></div><div class="k">${k}</div><div class="v">${vals.map((v) => `<span>${v}</span>`).join('')}<span class="m">••••••••••••••••••••</span></div>`;
    $('#rows').append(r);
  });
  const rowEls = $$('.row');
  const vs = (i) => rowEls.map((r) => r.querySelectorAll('.v span')[i]);
  tl.set([...vs(1), ...vs(2), ...vs(3)], { autoAlpha: 0 }, 0);
  appear(rowEls, CUT.s6 + .3, { y: 20, stagger: .08, dur: .5 });
  const show = (from, to, t) => { tl.to(vs(from), { autoAlpha: 0, y: -14, duration: .12 }, t); tl.fromTo(vs(to), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: .22, immediateRender: false }, t + .1); };
  const seg = 220;
  tl.to('#pickb', { x: seg, duration: .4, ease: 'expo.out' }, on('env', 'environment')); show(0, 1, on('env', 'environment')); sfx('tick', on('env', 'environment'), .6);
  tl.to('#pickb', { x: seg * 2, duration: .4, ease: 'expo.out' }, on('env', 'variable')); show(1, 2, on('env', 'variable')); sfx('tick', on('env', 'variable'), .6);
  const tEnc = on('env', 'encrypted') - .04;
  tl.fromTo('#scan', { y: 80, opacity: 1 }, { y: 520, opacity: 1, duration: .6, ease: 'power1.inOut', immediateRender: false }, tEnc);
  tl.to('#scan', { opacity: 0, duration: .14 }, tEnc + .54);
  sfx('scan', tEnc, .7);
  rowEls.forEach((r, i) => {
    const at = tEnc + .12 + i * .15;
    tl.to(r.querySelectorAll('.v span')[2], { autoAlpha: 0, duration: .06 }, at);
    tl.to(r.querySelectorAll('.v span')[3], { autoAlpha: 1, duration: .06 }, at);
    tl.to(r.querySelector('.on'), { opacity: 1, duration: .16 }, at);
    sfx('tick', at, .5);
  });

  // --- S7: Seven ------------------------------------------------------------------------------------------------------
  scene('#s7', CUT.s7, CUT.s8 + .02);
  tl.to('#envcard, #ev', { autoAlpha: 0, scale: .9, duration: .3, ease: 'power3.in' }, CUT.s7 - .74);
  gate(CUT.s7, 'dawn');
  rise($('#sl h2'), on('sev', 'seven') - .08, { dur: .9 });
  appear($('#onsh'), on('sev', 'agent') - .05);
  tl.fromTo('#onsh i', { scale: 1, opacity: 1 }, { scale: 1.45, opacity: .5, duration: .5, ease: 'sine.inOut', repeat: 8, yoyo: true }, CUT.s7);
  [['Database copied off the server', on('sev', 'backs')], ['Restore proven', on('sev', 'data') + .2]].forEach(([n, t]) => {
    const d = document.createElement('div'); d.className = 'sv'; d.innerHTML = `<b>${TICK}</b><span>${n}</span>`; $('#svn').append(d);
    tl.fromTo(d, { autoAlpha: 0, x: 70 }, { autoAlpha: 1, x: 0, duration: .6, ease: 'expo.out' }, t);
    sfx('pop', t, .8);
  });

  // --- S8: order. The same logos, now in orbit around one 7 ---------------------------------------------------------------
  scene('#s8', CUT.s8, CUT.s9 + .02);
  tl.to('#sl, #svn', { autoAlpha: 0, x: 0, scale: .92, duration: .3, ease: 'power3.in' }, CUT.s8 - .34);
  sfx('boom', CUT.s8, .7);
  mood('night', CUT.s8 - .3, .7, .85);
  tl.set(u, { fx: 16, fy: 16, sx: 960, sy: 412, unit: 15, zoom: 1, mark: 1, bar: 0, stroke: 0, glint: -5 }, CUT.s8 - .02);
  tl.fromTo(u, { bar: 0 }, { bar: 1, duration: .5, ease: 'expo.out', immediateRender: false }, CUT.s8);
  tl.fromTo(u, { stroke: 0 }, { stroke: 1, duration: .6, ease: 'expo.out', immediateRender: false }, CUT.s8 + .08);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.3, ease: 'power2.inOut', immediateRender: false }, CUT.s8 + .3);
  const rings = [[8, 450, 232, 0], [16, 810, 338, .2]];
  const cx = 960, cy = 412, orbitKeys = [...ALL];
  let oi = 0;
  rings.forEach(([n, rx, ry, off]) => {
    for (let i = 0; i < n; i++) {
      const a = (i + off) / n * Math.PI * 2 - Math.PI / 2, x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
      const el = tile(orbitKeys[oi++ % orbitKeys.length], 62); el.style.left = `${x}px`; el.style.top = `${y}px`; $('#orbit').append(el);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx); line.setAttribute('y1', cy); line.setAttribute('x2', x); line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(255,255,255,.13)'); line.setAttribute('stroke-width', '1.5'); line.setAttribute('pathLength', '1'); line.style.strokeDasharray = '1'; $('#lines').append(line);
      const t = CUT.s8 + .22 + rnd() * .75;
      tl.fromTo(el, { x: cx - x, y: cy - y, scale: 0 }, { x: 0, y: 0, scale: 1, duration: .85, ease: 'expo.out' }, t);
      tl.fromTo(line, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: .7, ease: 'expo.out' }, t);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', 4); dot.setAttribute('fill', '#C6F432'); dot.style.opacity = 0; $('#lines').append(dot);
      const s = { p: 0 }, place = () => { dot.setAttribute('cx', cx + (x - cx) * s.p); dot.setAttribute('cy', cy + (y - cy) * s.p); };
      tl.to(s, { p: 1, duration: 1, ease: 'none', repeat: 3, repeatDelay: .3 + rnd(), onUpdate: place }, t + .7 + rnd());
      tl.to(dot, { opacity: 1, duration: .2 }, t + .9);
    }
  });
  for (let i = 0; i < 10; i++) sfx('tick', CUT.s8 + .3 + i * .09, .36);
  rise($('#r1'), VO.end1 - .03, { stagger: .05, dur: .6 });
  rise($('#r2'), VO.end2 - .02, { stagger: .08, dur: .7 });

  // --- S9: open source, in daylight -----------------------------------------------------------------------------------------
  scene('#s9', CUT.s9, CUT.s10 + 1);
  sweep(CUT.s9);
  mood('day', CUT.s9 - .2, .4);
  tl.set(u, { mark: 0 }, CUT.s9 + .02);
  rise($('#os1'), on('os', 'open') - .08, { dur: .6, stagger: .1 });
  rise($('#os2'), on('os', 'all') - .08, { dur: .6, stagger: .1 });

  // --- S10: the name ------------------------------------------------------------------------------------------------------------
  const END = CUT.s10 + BAR / 4;
  scene('#s10', END, LEN + 1);
  tl.set('#s9', { visibility: 'hidden' }, END);
  mood('night', END - .2, .3, 1);
  sweep(END, .5);
  sfx('rise', END - 1.5, .7);
  sfx('hit', END, 1);
  tl.set(u, { fx: 16, fy: 16, sx: 960, sy: 370, unit: 24, zoom: 1, mark: 1, bar: 0, stroke: 0, glint: -5 }, END - .03);
  tl.fromTo(u, { bar: 0 }, { bar: 1, duration: .7, ease: 'expo.out', immediateRender: false }, END);
  tl.fromTo(u, { stroke: 0 }, { stroke: 1, duration: .8, ease: 'expo.out', immediateRender: false }, END + .08);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.4, ease: 'power2.inOut', immediateRender: false }, END + .3);
  rise($('#endw h2'), END + .05, { dur: .8 });
  appear($('#endw p'), END + .3);
  appear($('#endc'), END + .8, { y: 0 });
  tl.to('#stage', { opacity: 0, duration: .5, ease: 'power2.in' }, LEN - .55);
  tl.to(u, { intensity: 0, mark: 0, duration: .5, ease: 'power2.in' }, LEN - .55);

  // The cursor aims at where the button really is at that moment.
  const aim = (sel, t) => { tl.seek(t, false); const r = $(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const press = (sel, t, enter) => {
    const p = aim(sel, t);
    tl.set('#cur', { x: enter[0], y: enter[1], opacity: 0 }, t - .95);
    tl.to('#cur', { opacity: 1, duration: .16 }, t - .95);
    tl.to('#cur', { x: p.x - 8, y: p.y - 6, duration: .8, ease: 'power3.inOut' }, t - .88);
    tl.to(sel, { scale: .95, duration: .08, ease: 'power2.out' }, t - .06);
    tl.to(sel, { scale: 1, duration: .16 }, t + .03);
    tl.set('#rip', { left: p.x, top: p.y }, t - .01);
    tl.fromTo('#rip', { scale: .3, opacity: 1 }, { scale: 1.5, opacity: 0, duration: .5, ease: 'power2.out', immediateRender: false }, t);
    tl.to('#cur', { opacity: 0, duration: .2 }, t + .3);
    sfx('click', t - .04, .9); sfx('pop', t + .22, .9);
  };
  press('#approve', tApprove, [1500, 1100]);

  // --- For the renderer --------------------------------------------------------------------------------------------------------
  window.__frames = Math.round(LEN * FPS);
  window.__seek = (f) => { const t = f / FPS; tl.seek(t, false); draw(t, Math.floor(f)); };
  window.__cues = () => ({ len: LEN, bar: BAR, kickAt: CUT.s1, end: END, lowpass: [CUT.s7 - .2, CUT.s8 - .05], vo: VO, sfx: sounds.sort((a, c) => a.t - c.t) });
  tl.seek(0, false); draw(0, 0);
  window.__ready = true;
})().catch((e) => { console.error(e.stack || e); });
