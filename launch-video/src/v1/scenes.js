// The film. One paused GSAP timeline; a frame is a seek, so any frame renders the same on any run.
(async () => {
  await document.fonts.ready;
  await Promise.all(['760 40px Archivo', 'italic 760 40px Archivo', '500 40px Geist', '500 40px "JetBrains Mono"'].map((f) => document.fonts.load(f)));

  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const { u, MOODS } = Shader;
  const dpr = +new URLSearchParams(location.search).get('dpr') || 1;
  const draw = Shader.start($('#gl'), dpr);

  // --- Time. The cut follows the music: 117 BPM, so a bar is 2.051s. src/grid.py checks it. ----------------------
  const FPS = 60, LEN = 60;
  const BAR = 240 / 117, BEAT = BAR / 4, b = (n) => n * BAR;
  const VO = { hook1: .4, hook2: 2.6, meet1: b(3), meet2: b(4), vibe: b(6), coder: b(10), adv: b(15), v2: b(19) + BEAT, seven: b(23), end: b(26.5), name: b(28) };
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // when a word is spoken, so a picture can land on it
  const on = (line, word, nth = 0) => {
    const hits = WORDS[line].filter(([w]) => clean(w).startsWith(clean(word)));
    if (!hits[nth]) throw new Error(`no word "${word}" in ${line}`);
    return VO[line] + hits[nth][1];
  };
  const CUT = { s0: 0, s1: b(3), s2: b(6), s3: b(10), s4: b(15), s5: b(19), s6: b(23), s7: b(26.5), s8: b(28) };
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
  const rise = (el, t, o = {}) => { const ws = el._w ?? (el._w = split(el)); tl.fromTo(ws, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: o.dur ?? .8, ease: 'expo.out', stagger: o.stagger ?? .05 }, t); return ws; };
  const sink = (el, t, o = {}) => tl.to(el._w, { yPercent: -150, duration: o.dur ?? .42, ease: 'power3.in', stagger: o.stagger ?? .012 }, t);
  const appear = (el, t, o = {}) => tl.fromTo(el, { autoAlpha: 0, y: o.y ?? 36 }, { autoAlpha: 1, y: 0, duration: o.dur ?? .7, ease: 'expo.out', stagger: o.stagger }, t);
  const leave = (el, t, o = {}) => tl.to(el, { autoAlpha: 0, y: o.y ?? -26, duration: o.dur ?? .32, ease: 'power2.in', stagger: o.stagger }, t);
  const type = (el, text, t, cps = 42, clearAt) => {
    const s = { n: 0 }, show = () => { el.textContent = text.slice(0, Math.round(s.n)); };
    tl.to(s, { n: text.length, duration: text.length / cps, ease: 'none', onUpdate: show }, t);
    if (clearAt) tl.to(s, { n: 0, duration: .01, ease: 'none', onUpdate: show }, clearAt);
    return text.length / cps;
  };
  const mood = (name, t, dur = 1.3, intensity) => {
    const m = MOODS[name];
    tl.to(u.pal, { endArray: m.pal, duration: dur, ease: 'power2.inOut' }, t);
    tl.to(u, { intensity: intensity ?? m.intensity, horizon: m.horizon, day: m.day, duration: dur, ease: 'power2.inOut' }, t);
  };
  const scene = (sel, from, to) => { tl.set(sel, { visibility: 'visible' }, from); tl.set(sel, { visibility: 'hidden' }, to); };
  // the two colours of the mark cross the frame; the cut happens behind them
  const sweep = (t, dur = .62) => {
    sfx('whoosh', t - .2, .85);
    for (const [s, d] of [['#sw1', 0], ['#sw2', .07]]) tl.fromTo(s, { x: 0 }, { x: 6000, duration: dur, ease: 'snap', immediateRender: false }, t - dur / 2 + d);
  };

  const TICK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M3.5 8.5 6.6 11.6 12.5 5"/></svg>';
  const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
  const KEY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5.5" cy="10.5" r="3"/><path d="m8 8 5-5m-2 2 2 2"/></svg>';

  // --- S0: the problem -------------------------------------------------------------------------------------------
  scene('#s0', 0, CUT.s1 + .1);
  mood('alert', 0, 1.8, .95);
  { const ws = split($('#h1a')); $('#h1a')._w = ws;
    const times = [on('hook1', 'AI'), on('hook1', 'writes'), on('hook1', 'your'), on('hook1', 'code'), on('hook1', 'in'), on('hook1', 'minutes')];
    ws.forEach((w, i) => tl.fromTo(w, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: .75, ease: 'expo.out' }, times[i] - .06)); }
  sink($('#h1a'), VO.hook2 - .42);
  rise($('#h1b'), VO.hook2 - .02, { stagger: .075, dur: .85 });
  const pains = $$('#pains li');
  pains.forEach((li, i) => {
    li.style.top = `${440 + i * 96}px`; li.style.left = `${980 - i * 96 * .62}px`;
    const t = VO.hook2 + 1.02 + i * .32;
    tl.fromTo(li, { clipPath: 'polygon(-5% -20%, -5% -20%, -35% 130%, -35% 130%)', autoAlpha: 0 }, { clipPath: 'polygon(-5% -20%, 130% -20%, 100% 130%, -35% 130%)', autoAlpha: 1, duration: .55, ease: 'power3.out' }, t);
    tl.to(li, { color: 'rgb(242 242 244 / .24)', duration: .5, ease: 'power2.out' }, t + .42);
    sfx('tick', t, .5);
  });
  sink($('#h1b'), CUT.s1 - .34);
  tl.to(pains, { x: -60, autoAlpha: 0, duration: .34, ease: 'power3.in', stagger: .02 }, CUT.s1 - .34);

  // --- S1: the mark ----------------------------------------------------------------------------------------------
  scene('#s1', CUT.s1, CUT.s2);
  mood('night', CUT.s1 - .5, 1.4, 1);
  tl.set(u, { fx: 16, fy: 16, sx: 960, sy: 500, unit: 30, zoom: 1, mark: 1 }, CUT.s1 - .01);
  tl.fromTo(u, { bar: 0 }, { bar: 1, duration: .95, ease: 'expo.out', immediateRender: false }, CUT.s1);
  tl.fromTo(u, { stroke: 0 }, { stroke: 1, duration: 1.0, ease: 'expo.out', immediateRender: false }, CUT.s1 + .28);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.3, ease: 'power2.inOut', immediateRender: false }, CUT.s1 + .55);
  sfx('rise', CUT.s1 - .1, .55);
  rise($('#wordmark'), on('meet1', 'Unit'), { dur: .7 });
  sink($('#wordmark'), CUT.s1 + 1.68, { dur: .3 });
  // on the kick: the mark takes the hero's place, and the promise lands
  const kick = VO.meet2;
  sfx('boom', kick, 1);
  tl.to(u, { sx: 1490, sy: 560, unit: 54, duration: 1.05, ease: 'expo.out' }, kick - .02);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.1, ease: 'power2.out', immediateRender: false }, kick);
  tl.fromTo(u, { swirl: .55 }, { swirl: 0, duration: 1.4, ease: 'power2.out', immediateRender: false }, kick);
  appear($('#hero .eyebrow'), kick + .05);
  { const h = $('#hero h1'); const ws = split(h); h._w = ws;
    const words = WORDS.meet2; ws.forEach((w, i) => {
      const spoken = words[Math.min(i + (i >= 1 ? 0 : 0), words.length - 1)];
      tl.fromTo(w, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: .8, ease: 'expo.out' }, VO.meet2 + (spoken ? spoken[1] : 0) * .86);
    }); }
  // through the 7, into the product
  const thru = CUT.s2 - 1.02;
  sink($('#hero h1'), thru - .1, { stagger: .006 });
  leave($('#hero .eyebrow'), thru - .1);
  tl.to(u, { fx: 11.4, fy: 15.6, sx: 960, sy: 540, duration: .62, ease: 'power3.inOut' }, thru);
  tl.to(u, { zoom: 46, duration: 1.0, ease: 'power4.in' }, thru + .08);
  tl.to(u, { fieldZoom: .6, duration: 1.0, ease: 'power3.in' }, thru + .02);
  tl.set(u, { mark: 0, zoom: 1, fieldZoom: 1 }, CUT.s2 + .02);
  sfx('whoosh', thru + .3, 1);

  // --- The small things that stay on screen -----------------------------------------------------------------------
  tl.to(['#lock', '#demo'], { opacity: 1, duration: .5, ease: 'power2.out' }, CUT.s2 + .2);
  tl.to(['#lock', '#demo'], { opacity: 0, duration: .3, ease: 'power2.in' }, CUT.s7 - .3);
  tl.to('#ticks', { opacity: 1, duration: .5, ease: 'power2.out' }, CUT.s2 + .2);
  tl.to('#ticks', { opacity: 0, duration: .3, ease: 'power2.in' }, CUT.s5 - .2);
  const ticks = $$('#ticks li');
  [[CUT.s2, CUT.s3], [CUT.s3, CUT.s4], [CUT.s4, CUT.s5]].forEach(([a, z], i) => {
    tl.fromTo(ticks[i].querySelector('b'), { scaleX: 0 }, { scaleX: 1, duration: z - a, ease: 'none' }, a);
    tl.to(ticks[i], { color: '#F2F2F4', duration: .3, ease: 'power2.out' }, a);
    if (i < 2) tl.to(ticks[i], { color: '#8C8C96', duration: .3, ease: 'power2.out' }, z);
  });

  // --- S2: vibe coders -------------------------------------------------------------------------------------------
  scene('#s2', CUT.s2, CUT.s3);
  tl.fromTo('#chat', { autoAlpha: 0, scale: .72, rotateY: -8, transformPerspective: 2200 }, { autoAlpha: 1, scale: 1, rotateY: 0, duration: 1.2, ease: 'expo.out' }, CUT.s2 - .02);
  appear($('#s2 .eyebrow'), CUT.s2 + .06);
  const h2 = $('#s2 h2'); { const ws = split(h2); h2._w = ws;
    ws.slice(0, 3).forEach((w, i) => tl.fromTo(w, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: .8, ease: 'expo.out' }, on('vibe', ['New', 'to', 'this'][i]) - .05));
    ws.slice(3).forEach((w, i) => tl.fromTo(w, { yPercent: 150, rotate: 5 }, { yPercent: 0, rotate: 0, duration: .8, ease: 'expo.out' }, on('vibe', ['just', 'say', 'what'][i]) - .05)); }
  appear($('#s2 .sub'), on('vibe', 'want'));

  // typing, then send
  const prompt = 'Put my app online, with a database and my domain';
  const tType = on('vibe', 'just') - .22;
  tl.set('#ph', { autoAlpha: 0 }, tType);
  const tSend = on('vibe', 'It') - .2;
  const dType = type($('#typed'), prompt, tType, 44, tSend);
  for (let i = 0; i < 14; i++) sfx('key', tType + i * dType / 14, .22);
  tl.fromTo('#caret', { opacity: 1 }, { opacity: 0, duration: .3, ease: 'steps(1)', repeat: 6, yoyo: true }, CUT.s2 + .3);
  sfx('send', tSend, .55);
  tl.set('#ph', { autoAlpha: 1 }, tSend);
  tl.fromTo('#bub', { y: 520, autoAlpha: 0, scale: .9, transformOrigin: '100% 100%' }, { y: 0, autoAlpha: 1, scale: 1, duration: .7, ease: 'expo.out' }, tSend);

  const stepsData = [['Deployed web', 'health check passed', on('vibe', 'deploys')], ['Postgres made and wired in', 'DATABASE_URL set, password in the vault', on('vibe', 'wires')], ['nestly.example', 'one step left: needs your yes', on('vibe', 'points')]];
  stepsData.forEach(([a, c, t], i) => {
    const el = document.createElement('div'); el.className = 'step';
    el.innerHTML = `<div class="ring"><svg class="spin" viewBox="0 0 44 44" fill="none"><circle cx="22" cy="22" r="17" stroke="currentColor" stroke-width="4" stroke-dasharray="70 40" stroke-linecap="round"/></svg><div class="bg"></div><svg class="done" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M3.5 8.5 6.6 11.6 12.5 5"/></svg></div><div>${a}<small>${c}</small></div>`;
    $('#steps').append(el);
    appear(el, t - .12, { y: 24, dur: .5 });
    const spin = el.querySelector('.spin'), bg = el.querySelector('.bg'), done = el.querySelector('.done');
    tl.fromTo(spin, { rotate: 0 }, { rotate: 720, duration: 1.3, ease: 'none' }, t - .12);
    tl.fromTo([bg, done], { scale: 0 }, { scale: 1, duration: .42, ease: 'back.out(2.4)' }, t + (i === 2 ? 1.0 : .62));
    tl.to(spin, { opacity: 0, duration: .1 }, t + (i === 2 ? 1.0 : .62));
    sfx('pop', t + (i === 2 ? 1.0 : .62), .7);
  });

  // the one question
  const tAsk = on('vibe', 'asks') - .1;
  tl.to('#side .none', { autoAlpha: 0, duration: .2 }, tAsk);
  tl.fromTo('#card', { autoAlpha: 0, x: 60, scale: .92 }, { autoAlpha: 1, x: 0, scale: 1, duration: .75, ease: 'expo.out' }, tAsk);
  sfx('card', tAsk, .7);
  tl.to('#chat', { x: -120, y: -14, scale: 1.09, duration: 1.4, ease: 'power3.inOut', transformOrigin: '100% 42%' }, tAsk + .05);
  tl.to('#s2 .left', { autoAlpha: 0, x: -60, duration: .5, ease: 'power2.in' }, tAsk + .05);

  // --- S3: coders ------------------------------------------------------------------------------------------------
  scene('#s3', CUT.s3, CUT.s4);
  sweep(CUT.s3);
  mood('deep', CUT.s3 - .3, 1, .9);
  appear($('#s3 .eyebrow'), CUT.s3 + .08);
  rise($('#t3a'), CUT.s3 + .1, { stagger: .05 });
  tl.fromTo('#envcard', { autoAlpha: 0, y: 90 }, { autoAlpha: 1, y: 0, duration: .9, ease: 'expo.out' }, CUT.s3 + .12);
  tl.fromTo('#empty', { autoAlpha: 1 }, { autoAlpha: 1, duration: .01 }, CUT.s3);

  const rows = [
    ['DATABASE_URL', ['postgres://app:hunter2@db/nestly', 'postgres://app:hunter2@db-staging/nestly', 'postgres://app:hunter2@db-dev/nestly'], true, 4],
    ['STRIPE_SECRET_KEY', ['credential://stripe/live/key', 'credential://stripe/test/key', 'credential://stripe/test/key'], false, 2],
    ['JWT_SECRET', ['correct-horse-battery', 'correct-horse-battery', 'correct-horse-battery'], true, 3],
    ['SITE_URL', ['https://nestly.example', 'https://staging.nestly.example', 'a free test address'], false, 1],
    ['RESEND_API_KEY', ['re_demo_7c1e0b', 're_demo_7c1e0b', 're_demo_7c1e0b'], true, 2],
  ];
  rows.forEach(([k, vals, secret, v]) => {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<div class="ic">${KEY}<div class="on">${LOCK}</div></div><div class="k">${k}</div><div class="v"></div><div class="ver">v<b>${v}</b> · now</div>`;
    const box = r.querySelector('.v');
    vals.forEach((val, i) => { const s = document.createElement('span'); s.textContent = val; box.append(s); if (secret) { const m = document.createElement('span'); m.className = 'mask'; m.textContent = '••••••••••••••••••••'; box.append(m); } });
    $('#rows').append(r);
    r._secret = secret;
  });
  const rowEls = $$('.row');
  // the .env drops in and unpacks into rows
  const tEnv = on('coder', 'every');
  rise($('#t3b'), tEnv, { stagger: .05 });
  sink($('#t3a'), tEnv - .3, { stagger: .008 });
  tl.fromTo('#dotenv', { autoAlpha: 0, y: -150, rotate: -5 }, { autoAlpha: 1, y: 0, rotate: 0, duration: .55, ease: 'expo.out' }, tEnv - .28);
  sfx('card', tEnv - .28, .6);
  tl.to('#dotenv', { x: 240, y: 90, scale: .32, autoAlpha: 0, duration: .36, ease: 'power3.in' }, tEnv + .5);
  tl.to('#empty', { autoAlpha: 0, duration: .15 }, tEnv + .72);
  rowEls.forEach((r, i) => { tl.fromTo(r, { autoAlpha: 0, x: -36 }, { autoAlpha: 1, x: 0, duration: .5, ease: 'expo.out' }, tEnv + .76 + i * .08); sfx('tick', tEnv + .76 + i * .08, .4); });
  // only production's text to begin with
  const cols = (i) => rowEls.map((r) => r.querySelectorAll('.v span:not(.mask)')[i]);
  const masks = (i) => rowEls.filter((r) => r._secret).map((r) => r.querySelectorAll('.v .mask')[i]);
  tl.set([...cols(1), ...cols(2), ...masks(0), ...masks(1), ...masks(2)], { autoAlpha: 0 }, 0);
  // saved, encrypted, versioned
  const chips = $$('.chip');
  [['Saved', 'saved'], ['Encrypted', 'encrypted'], ['Versioned', 'versioned']].forEach(([_, w], i) => {
    const t = on('coder', w);
    tl.fromTo(chips[i], { autoAlpha: 0, x: -26 }, { autoAlpha: 1, x: 0, duration: .5, ease: 'expo.out' }, t - .04);
    sfx('pop', t - .04, .5);
  });
  // encrypted: a line of light turns every secret into a sealed value
  const tEnc = on('coder', 'encrypted') - .04;
  tl.fromTo('#scan', { y: 60, opacity: 1 }, { y: 560, opacity: 1, duration: .62, ease: 'power1.inOut', immediateRender: false }, tEnc);
  tl.to('#scan', { opacity: 0, duration: .14 }, tEnc + .56);
  sfx('scan', tEnc, .6);
  rowEls.filter((r) => r._secret).forEach((r) => {
    const i = rowEls.indexOf(r), at = tEnc + .1 + i * .13;
    tl.to(r.querySelectorAll('.v span:not(.mask)')[0], { autoAlpha: 0, duration: .06 }, at);
    tl.to(r.querySelectorAll('.v .mask')[0], { autoAlpha: 1, duration: .06 }, at);
  });
  rowEls.forEach((r, i) => tl.to(r.querySelector('.on'), { opacity: 1, duration: .16, ease: 'power2.out' }, tEnc + .1 + i * .13));
  // versioned: every number ticks up
  rowEls.forEach((r, i) => {
    const b_ = r.querySelector('.ver b'), n = { v: +b_.textContent };
    tl.to(n, { v: n.v + 1, duration: .01, onUpdate() { b_.textContent = Math.round(n.v); } }, on('coder', 'versioned') + .05 + i * .07);
    tl.fromTo(b_, { color: '#fff' }, { color: '#C6F432', duration: .4, immediateRender: false }, on('coder', 'versioned') + .05 + i * .07);
  });
  // across every environment
  const seg = 160;
  const go = (i, t) => {
    tl.to('#pickb', { x: i * seg, duration: .5, ease: 'expo.out' }, t);
    sfx('tick', t, .6);
    rowEls.forEach((r, ri) => {
      const secret = r._secret, oldEl = r.querySelectorAll(secret ? '.v .mask' : '.v span:not(.mask)')[i - 1], newEl = r.querySelectorAll(secret ? '.v .mask' : '.v span:not(.mask)')[i];
      tl.to(oldEl, { autoAlpha: 0, y: -16, duration: .16, ease: 'power2.in' }, t + ri * .03);
      tl.fromTo(newEl, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: .26, immediateRender: false }, t + .14 + ri * .03);
    });
  };
  go(1, on('coder', 'across')); go(2, on('coder', 'environment', 1) + .2);
  // back to production, and the point of it all
  const tRef = on('coder', 'Your', 1);
  tl.to('#pickb', { x: 0, duration: .45, ease: 'expo.out' }, tRef - .22);
  rowEls.forEach((r) => {
    const secret = r._secret, sel = secret ? '.v .mask' : '.v span:not(.mask)';
    tl.to(r.querySelectorAll(sel)[2], { autoAlpha: 0, duration: .12 }, tRef - .22);
    tl.to(r.querySelectorAll(sel)[0], { autoAlpha: 1, y: 0, duration: .2 }, tRef - .12);
  });
  tl.to(rowEls[1].querySelectorAll('.v span:not(.mask)')[0], { color: '#C6F432', duration: .3 }, tRef);
  tl.fromTo('#aisees', { autoAlpha: 0, y: 50, scale: .94 }, { autoAlpha: 1, y: 0, scale: 1, duration: .7, ease: 'expo.out' }, tRef);
  sfx('card', tRef, .8);

  // --- S4: advanced ----------------------------------------------------------------------------------------------
  scene('#s4', CUT.s4, CUT.s5);
  sweep(CUT.s4);
  mood('night', CUT.s4 - .3, 1, .7);
  const tools = 'deployment.rollback env.restore backup.verify server.harden fleet.canary coolify.build database.slow_queries domain.launch security.stranger safety.rehearse secrets.rotation cost.radar staging.create dr.drill service.autoscale finding.judge audit.export config.plan part.verify watch.anomalies link.rotate routine.create project.readiness server.xray story.timeline uptime.sync'.split(' ');
  $('#names').innerHTML = Array.from({ length: 6 }, () => tools.join('<br>')).join('<br>');
  tl.fromTo('#names', { autoAlpha: 0 }, { autoAlpha: 1, duration: .6 }, CUT.s4 + .1);
  tl.fromTo('#names', { scrollTop: 0, y: 0 }, { y: -2200, duration: b(4), ease: 'none' }, CUT.s4);
  appear($('#s4a .eyebrow'), CUT.s4 + .08);
  rise($('#s4a h2'), on('adv', 'Run') + .05, { stagger: .06 });
  const big = $('#big400'), n400 = { v: 0 };
  const t400 = on('adv', '400') - .12;
  tl.fromTo(big, { autoAlpha: 0 }, { autoAlpha: 1, duration: .1 }, t400);
  tl.to(n400, { v: 400, duration: .95, ease: 'expo.out', onUpdate() { big.textContent = `${Math.round(n400.v)}${n400.v > 399 ? '+' : ''}`; } }, t400);
  sfx('rise', t400 - .15, .4); sfx('pop', t400 + .7, .6);
  appear($('#big400lab'), t400 + .32);
  tl.fromTo('#term', { autoAlpha: 0, x: 90, scale: .96 }, { autoAlpha: 1, x: 0, scale: 1, duration: .8, ease: 'expo.out' }, on('adv', 'over'));
  // the terminal: only commands the CLI really has
  const term = [['$ ', 'unit7 connect claude', 'p'], ['', 'Claude Code now reaches Unit7 over MCP', 'o'], ['$ ', 'unit7 run service.restart --dry-run', 'p'], ['', 'Shows the plan. Changes nothing.', 'o'], ['$ ', 'unit7 checkup --json --fail-on high', 'p'], ['', 'exit 0', 'o']];
  const pre = $('#termtext'), lines = term.map(([p, s, c]) => { const l = document.createElement('div'); l.innerHTML = c === 'p' ? `<span class="p">${p}</span><span class="t"></span>` : `<span class="o t"></span>`; pre.append(l); return { el: l.querySelector('.t'), s, c }; });
  let tt = on('adv', 'over') + .3;
  lines.forEach((l) => { if (l.c === 'p') { tt += type(l.el, l.s, tt, 62) + .1; } else { type(l.el, l.s, tt, 900); tt += .18; } });
  for (let i = 0; i < 10; i++) sfx('key', on('adv', 'over') + .3 + i * .22, .16);

  // one gate
  const tGate = on('adv', 'one');
  tl.to('#s4a', { autoAlpha: 0, x: -80, duration: .3, ease: 'power2.in' }, tGate - .3);
  tl.to('#names', { autoAlpha: 0, duration: .3 }, tGate - .3);
  rise($('#gate h3'), tGate - .04, { stagger: .05 });
  const nodes = ["Who’s asking?", 'Are they allowed?', 'What does this place allow?', 'Does it need a person?', 'Approval', 'Backup first', 'Run', 'Hide secrets', 'Write it down'];
  nodes.forEach((n, i) => {
    const d = document.createElement('div'); d.className = 'gn'; d.style.left = `${150 + (i / (nodes.length - 1)) * 1620}px`;
    d.innerHTML = `<i></i><span>${n}</span>`; $('#gnodes').append(d);
    const t = tGate + .12 + i * .17;
    tl.fromTo(d, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: .36, ease: 'expo.out' }, t);
    tl.to(d.querySelector('i'), { background: '#C6F432', boxShadow: '0 0 26px rgba(198,244,50,.8)', duration: .16 }, t + .08);
    tl.to(d.querySelector('span'), { color: '#F2F2F4', duration: .2 }, t + .08);
    sfx('tick', t + .08, .36);
  });
  tl.fromTo('#gline', { autoAlpha: 0 }, { autoAlpha: 1, duration: .2 }, tGate);
  tl.fromTo('#gfill', { scaleX: 0 }, { scaleX: 1, duration: .17 * 8 + .1, ease: 'none' }, tGate + .2);
  const au = [['14:02:11', 'env.set STRIPE_SECRET_KEY', 'prev 9f3a… → c21e…'], ['14:02:38', 'deployment.promote web', 'prev c21e… → 77b0…'], ['14:03:02', 'backup.verify postgres', 'prev 77b0… → e4d6…']];
  const tAud = on('adv', 'audit') - .3;
  au.forEach((r, i) => { const d = document.createElement('div'); d.className = 'au'; d.innerHTML = `<span>${r[0]}</span><b>${r[1]}</b><span>${r[2]}</span>`; $('#audit').append(d); tl.fromTo(d, { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: .34, ease: 'expo.out' }, tAud + i * .1); });

  // --- S5: V2 ----------------------------------------------------------------------------------------------------
  scene('#s5', CUT.s5, CUT.s6);
  sweep(CUT.s5);
  mood('safe', CUT.s5 - .3, 1.1, .8);
  const v2n = $('#v2big .num');
  tl.fromTo(v2n, { autoAlpha: 0, scale: 1.7, filter: 'blur(14px)' }, { autoAlpha: 1, scale: 1, filter: 'blur(0px)', duration: .85, ease: 'expo.out' }, CUT.s5 + .1);
  sfx('boom', CUT.s5 + .1, .55);
  rise($('#v2big h2'), on('v2', 'doesn') - .06, { stagger: .07 });
  const tCk = on('v2', 'checkup') - .32;
  tl.to(v2n, { autoAlpha: 0, scale: .86, duration: .3, ease: 'power2.in' }, tCk - .12);
  sink($('#v2big h2'), tCk - .12, { stagger: .006 });
  appear($('#lc1 .eyebrow'), tCk + .14);
  rise($('#lc1 h2'), tCk + .14);
  appear($('#lc1 p:last-child'), tCk + .32);
  tl.fromTo('#ck', { autoAlpha: 0, x: 90, scale: .96 }, { autoAlpha: 1, x: 0, scale: 1, duration: .75, ease: 'expo.out' }, tCk + .1);
  $$('.ca').forEach((c, i) => {
    const t = tCk + .34 + i * .16;
    tl.fromTo(c.querySelector('.mk'), { scale: 0 }, { scale: 1, duration: .4, ease: 'back.out(2.2)' }, t);
    tl.fromTo(c.querySelector('.tag'), { autoAlpha: 0, x: 18 }, { autoAlpha: 1, x: 0, duration: .36 }, t + .05);
    sfx('pop', t, .42);
  });
  const tNet = on('v2', 'Safety') - .34;
  tl.to('#ck', { autoAlpha: 0, x: 70, duration: .3, ease: 'power2.in' }, tNet - .14);
  tl.to('#lc1', { autoAlpha: 0, x: -50, duration: .3, ease: 'power2.in' }, tNet - .14);
  appear($('#lc2 .eyebrow'), tNet + .14);
  rise($('#lc2 h2'), tNet + .14);
  appear($('#lc2 p:last-child'), tNet + .3);
  tl.fromTo('#ladder', { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: .6, ease: 'expo.out' }, tNet + .1);
  const logs = ['Copies the database', 'Sends an encrypted copy off the server', 'Restores it into a throwaway copy, counts every row'];
  logs.forEach((l) => { const li = document.createElement('li'); li.innerHTML = `${TICK}<span>${l}</span>`; $('#llog').append(li); });
  const li = $$('#llog li'), rung = $$('#lrungs li');
  const tCopy = on('v2', 'copies'), tProve = on('v2', 'proves');
  tl.fromTo('#lfill', { scaleX: 0 }, { scaleX: .68, duration: tProve - tCopy, ease: 'power2.inOut' }, tCopy - .1);
  tl.to('#lfill', { scaleX: 1, duration: .75, ease: 'expo.out' }, tProve);
  sfx('rise', tProve - .3, .36); sfx('pop', tProve + .55, .9);
  tl.fromTo(li[0], { autoAlpha: 0, x: -20 }, { autoAlpha: 1, x: 0, duration: .36 }, tCopy);
  tl.fromTo(li[1], { autoAlpha: 0, x: -20 }, { autoAlpha: 1, x: 0, duration: .36 }, tCopy + .5);
  tl.fromTo(li[2], { autoAlpha: 0, x: -20 }, { autoAlpha: 1, x: 0, duration: .36 }, tProve);
  tl.to(rung[0], { color: '#F2F2F4', duration: .2 }, tCopy);
  tl.to(rung[1], { color: '#F2F2F4', duration: .2 }, tCopy + .3);
  tl.to(rung[2], { color: '#F2F2F4', duration: .2 }, tCopy + .7);
  tl.fromTo(rung[3], { color: '#8C8C96' }, { color: '#C6F432', duration: .2 }, tProve + .5);
  tl.fromTo(rung[3], { scale: 1 }, { scale: 1.12, duration: .3, ease: 'back.out(2)', transformOrigin: '0 50%' }, tProve + .5);
  // everything else V2 does, in passing
  const more = ['Give this to my AI', 'Fix check', 'Call Inspector', 'What can a stranger do?', 'Have I been hacked?', 'Outpost', 'Fire drill', 'Lifeboat', 'Open a past copy', 'Staging copies', 'Rollback', 'The Map', 'Routines', 'Autopilot', 'Warden'];
  $('#mq').innerHTML = [...more, ...more].map((m) => `${m}<i>/</i>`).join('');
  tl.fromTo('#mq', { autoAlpha: 0 }, { autoAlpha: 1, duration: .5 }, CUT.s5 + .3);
  tl.fromTo('#mq', { x: 40 }, { x: -2600, duration: CUT.s6 - CUT.s5, ease: 'none' }, CUT.s5);

  // --- S6: Seven -------------------------------------------------------------------------------------------------
  scene('#s6', CUT.s6, CUT.s7);
  sweep(CUT.s6);
  mood('dawn', CUT.s6 - .3, 1.3, .75);
  appear($('#s6 .eyebrow'), CUT.s6 + .08);
  rise($('#s6 h2'), on('seven', 'adds') - .05, { dur: .9 });
  appear($('#s6 .sub'), on('seven', 'an') - .04);
  tl.fromTo('#seven', { autoAlpha: 0, x: 100, scale: .95 }, { autoAlpha: 1, x: 0, scale: 1, duration: .95, ease: 'expo.out' }, CUT.s6 + .3);
  tl.fromTo('#seven .on i', { scale: 1, opacity: 1 }, { scale: 1.5, opacity: .5, duration: .5, ease: 'sine.inOut', repeat: 12, yoyo: true }, CUT.s6);
  // a shift, one step at a time, while the line says "an agent on shift"
  $$('#shift li').forEach((li, i) => {
    const bar = document.createElement('b'); li.append(bar);
    const t = on('seven', 'an') + i * .3;
    tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: .34, ease: 'power2.out' }, t);
    tl.to(li, { color: '#F2F2F4', duration: .2 }, t + .1);
    sfx('tick', t, .3);
  });
  // the safe work is simply done; the one question pushes it down
  const tDone = on('seven', 'safe') - .14, tQ = on('seven', 'asks') - .36;
  tl.fromTo('#doneblock', { y: -270 }, { y: 0, duration: .6, ease: 'expo.inOut' }, tQ - .1);
  tl.fromTo('#doneblock', { autoAlpha: 0 }, { autoAlpha: 1, duration: .4 }, CUT.s6 + .7);
  tl.fromTo('#dn1', { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: .5, ease: 'expo.out' }, tDone);
  sfx('pop', tDone, .6);
  tl.fromTo('#askbox', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: .55, ease: 'expo.out' }, tQ);
  sfx('card', tQ, .6);
  tl.fromTo('#seven .calm', { opacity: 1 }, { opacity: .55, duration: .2 }, tQ);

  // --- S7: open source, in daylight ---------------------------------------------------------------------------------
  scene('#s7', CUT.s7, CUT.s8);
  sweep(CUT.s7);
  mood('day', CUT.s7 - .2, .5);
  ['#w1', '#w2', '#w3'].forEach((s, i) => { const t = on('end', ['self', 'open', 'yours'][i]) - .06; rise($(s), t, { dur: .7 }); sfx('pop', t, .8); });
  appear($$('#facts span'), on('end', 'yours') + .1, { stagger: .07, y: 18, dur: .5 });

  // --- S8: the name --------------------------------------------------------------------------------------------------
  scene('#s8', CUT.s8, LEN + 1);
  mood('night', CUT.s8 - .22, .35, 1);
  sweep(CUT.s8, .5);
  sfx('rise', CUT.s8 - 1.5, .8);
  sfx('hit', CUT.s8, 1);
  tl.set(u, { fx: 16, fy: 16, sx: 960, sy: 380, unit: 22, zoom: 1, mark: 1, bar: 0, stroke: 0, glint: -5 }, CUT.s8 - .03);
  tl.fromTo(u, { bar: 0 }, { bar: 1, duration: .8, ease: 'expo.out', immediateRender: false }, CUT.s8);
  tl.fromTo(u, { stroke: 0 }, { stroke: 1, duration: .85, ease: 'expo.out', immediateRender: false }, CUT.s8 + .1);
  tl.fromTo(u, { glint: -5 }, { glint: 46, duration: 1.5, ease: 'power2.inOut', immediateRender: false }, CUT.s8 + .35);
  tl.fromTo(u, { unit: 26 }, { unit: 24, duration: 3, ease: 'power2.out', immediateRender: false }, CUT.s8);
  rise($('#endw h2'), CUT.s8 + .06, { dur: .8 });
  appear($('#endw p'), CUT.s8 + .34);
  appear($('#endc'), CUT.s8 + .9, { y: 0 });
  tl.to('#stage', { opacity: 0, duration: .5, ease: 'power2.in' }, LEN - .55);
  tl.to(u, { intensity: 0, mark: 0, duration: .5, ease: 'power2.in' }, LEN - .55);

  // The cursor aims at where the button really is at that moment, camera moves included.
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
  const tApprove = on('vibe', 'risky') + .52;
  press('#approve', tApprove, [1760, 1100]);
  tl.to('#card', { autoAlpha: 0, scale: .94, duration: .22, ease: 'power2.in' }, tApprove + .1);
  tl.fromTo('#receipt', { autoAlpha: 0, y: 26, scale: .96 }, { autoAlpha: 1, y: 0, scale: 1, duration: .5, ease: 'expo.out' }, tApprove + .2);

  const tYes = VO.seven + WORDS.seven.at(-1)[2] - .28;
  press('#yes', tYes, [1500, 1100]);
  tl.to('#q', { autoAlpha: .32, duration: .2 }, tYes + .1);
  tl.fromTo('#dn2', { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: .45, ease: 'expo.out' }, tYes + .16);

  // --- For the renderer --------------------------------------------------------------------------------------------
  window.__frames = Math.round(LEN * FPS);
  window.__seek = (f) => { const t = f / FPS; tl.seek(t, false); draw(t, Math.floor(f)); };
  window.__cues = () => ({ len: LEN, bar: BAR, vo: VO, sfx: sounds.sort((a, c) => a.t - c.t) });
  tl.seek(0, false); draw(0, 0);
  window.__ready = true;
})().catch((e) => { console.error(e.stack || e); });
