/* Shared behaviour: theme toggle, scroll progress, nav highlight, reveal, splat field. */
(function () {
  var root = document.documentElement;
  var darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function isDark() {
    var t = root.getAttribute('data-theme');
    return t ? t === 'dark' : darkMq.matches;
  }
  function onMqChange(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
  }

  /* ---- Theme toggle ---- */
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) toggle.addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });

  /* ---- Scroll progress + active nav link ---- */
  var bar = document.querySelector('.scroll-progress');
  var navLinks = {};
  Array.prototype.forEach.call(document.querySelectorAll('.site-nav a[href^="#"]'), function (a) {
    navLinks[a.getAttribute('href').slice(1)] = a;
  });
  var currentId = null;
  function setCurrent(id) {
    if (id === currentId) return;
    currentId = id;
    for (var k in navLinks) {
      if (k === id) navLinks[k].setAttribute('aria-current', 'location');
      else navLinks[k].removeAttribute('aria-current');
    }
  }
  // Only in-page anchors ("#id") are tracked, so on subpages (links like "index.html#id") nothing is highlighted.
  var spied = Object.keys(navLinks).map(function (id) { return document.getElementById(id); })
    .filter(function (el) { return el; });
  var ticking = false;
  function onScroll() {
    ticking = false;
    var y = window.scrollY;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
    if (!spied.length) return;
    // The last section whose top has passed 40% of the viewport is current; the bottom of the page selects the last one.
    var current = spied[0].id, line = y + window.innerHeight * 0.4;
    spied.forEach(function (el) {
      if (el.getBoundingClientRect().top + y <= line) current = el.id;
    });
    if (max > 0 && y >= max - 2) current = spied[spied.length - 1].id;
    setCurrent(current);
  }
  function queueScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }
  window.addEventListener('scroll', queueScroll, { passive: true });
  window.addEventListener('resize', queueScroll);
  onScroll();

  if ('IntersectionObserver' in window) {
    /* ---- Scroll reveal ---- */
    if (!still) {
      root.classList.add('reveal-on');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
        });
      }, { rootMargin: '0px 0px -6% 0px' });
      Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) { io.observe(el); });
    }
  }

  /* ---- Gaussian splat field ----
     Anisotropic 2D Gaussians start from a random init and "converge" on load,
     drift slowly, get nudged by the cursor, and show their 2σ ellipses up close. */
  var canvas = document.querySelector('.splats');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var hero = canvas.parentElement;
  // Optional per-page size multiplier, e.g. a smaller field in a shorter page header.
  var SCALE = parseFloat(canvas.getAttribute('data-scale')) || 1;

  var HUES = [[124, 92, 255], [255, 112, 84], [255, 186, 66], [38, 186, 166], [74, 144, 255], [255, 104, 168]];
  var seed = 20260930;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function jitter() { return (rnd() + rnd() + rnd() - 1.5) / 1.5; }

  var splats = [];
  function cluster(n, cx, cy, spx, spy, smin, smax, amin, amax) {
    for (var i = 0; i < n; i++) {
      var s = smin + (smax - smin) * Math.pow(rnd(), 1.5);
      splats.push({
        x: cx + jitter() * spx, y: cy + jitter() * spy,
        sx: s, sy: s * (0.2 + rnd() * 0.55), rot: rnd() * Math.PI,
        hue: Math.floor(rnd() * HUES.length),
        a: amin + (amax - amin) * rnd(),
        ph: rnd() * 6.2832, sp: 0.5 + rnd() * 0.8, amp: 0.006 + rnd() * 0.02,
        x0: rnd() * 1.1 - 0.05, y0: rnd() * 0.9, r0: rnd() * Math.PI, s0: 0.03 + rnd() * 0.06,
        delay: rnd() * 0.45, ox: 0, oy: 0
      });
    }
  }
  cluster(4, 0.78, 0.3, 0.16, 0.2, 0.12, 0.19, 0.12, 0.2);
  cluster(26, 0.77, 0.34, 0.19, 0.3, 0.03, 0.11, 0.3, 0.55);
  cluster(9, 0.95, 0.12, 0.08, 0.14, 0.015, 0.06, 0.35, 0.6);
  cluster(6, 0.08, 0.08, 0.1, 0.08, 0.012, 0.05, 0.3, 0.5);
  cluster(18, 0.66, 0.16, 0.4, 0.16, 0.006, 0.022, 0.4, 0.7);
  splats.sort(function (p, q) { return q.sx - p.sx; });

  var w = 0, h = 0, dpr = 1, dark = false, grads = [];
  var pointer = { x: -1e4, y: -1e4, on: 0, target: 0 };
  var running = false, raf = 0, last = 0, clock = 0, visible = true;
  var INTRO = 2.6;

  function buildGrads() {
    dark = isDark();
    grads = HUES.map(function (c) {
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (var i = 0; i <= 6; i++) {
        var r = i / 6, a = i === 6 ? 0 : Math.exp(-4.5 * r * r);
        g.addColorStop(r, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')');
      }
      return g;
    });
  }
  function ease(k) { return 1 - Math.pow(1 - k, 3); }

  function draw(t, intro, dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    var F = Math.min(w, 1100), left = (w - F) / 2;
    var R = F * 0.2, follow = 1 - Math.exp(-dt * 7);
    var wob = still ? 0 : 1, alphaScale = dark ? 0.8 : 1;
    var marks = [];
    ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
    for (var i = 0; i < splats.length; i++) {
      var s = splats[i];
      var k = ease(Math.max(0, Math.min(1, intro * (1 + s.delay) - s.delay)));
      var tx = s.x + wob * s.amp * Math.sin(t * 0.35 * s.sp + s.ph);
      var ty = s.y + wob * s.amp * Math.cos(t * 0.28 * s.sp + s.ph * 1.3);
      var rot = s.rot + wob * 0.2 * Math.sin(t * 0.2 * s.sp + s.ph);
      var x = left + (s.x0 + (tx - s.x0) * k) * F;
      var y = (s.y0 + (ty - s.y0) * k) * h;
      var sx = (s.s0 + (s.sx - s.s0) * k) * F * SCALE;
      var sy = (s.s0 + (s.sy - s.s0) * k) * F * SCALE;
      var r = s.r0 + (rot - s.r0) * k;

      var dx = x - pointer.x, dy = y - pointer.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      var push = pointer.on * Math.max(0, 1 - d / R);
      push = push * push * F * 0.05;
      s.ox += (dx / d * push - s.ox) * follow;
      s.oy += (dy / d * push - s.oy) * follow;
      x += s.ox; y += s.oy;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(x, y); ctx.rotate(r); ctx.scale(sx, sy);
      ctx.globalAlpha = s.a * alphaScale * Math.min(1, k * 1.6);
      ctx.fillStyle = grads[s.hue];
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, 6.2832); ctx.fill();

      var near = pointer.on * Math.max(0, 1 - d / R);
      near *= near;
      if (near > 0.02 && k > 0.97 && sy > 3) marks.push([x, y, sx, sy, r, near]);
    }
    if (marks.length) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      var ink = dark ? '236,235,241' : '23,22,28';
      for (var j = 0; j < marks.length; j++) {
        var m = marks[j], col = 'rgba(' + ink + ',' + (0.55 * m[5]).toFixed(3) + ')';
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.ellipse(m[0], m[1], m[2] * 0.667, m[3] * 0.667, m[4], 0, 6.2832); ctx.stroke();
        ctx.beginPath(); ctx.arc(m[0], m[1], 1.5, 0, 6.2832); ctx.fill();
      }
    }
  }

  function frame(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now; clock += dt;
    pointer.on += (pointer.target - pointer.on) * (1 - Math.exp(-dt * 5));
    draw(clock, Math.min(1, clock / INTRO), dt);
    raf = requestAnimationFrame(frame);
  }
  function play() { if (running || still) return; running = true; last = 0; raf = requestAnimationFrame(frame); }
  function pause() { running = false; cancelAnimationFrame(raf); }
  function redraw() { if (!running) draw(clock, still ? 1 : Math.min(1, clock / INTRO), 0); }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width; h = rect.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    redraw();
  }

  buildGrads();
  resize();
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);

  function retheme() { buildGrads(); redraw(); }
  new MutationObserver(retheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  onMqChange(darkMq, retheme);

  window.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    var rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.target = pointer.y >= 0 && pointer.y <= rect.height ? 1 : 0;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', function () { pointer.target = 0; });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !document.hidden) play(); else pause();
    }).observe(hero);
  } else {
    play();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause(); else if (visible) play();
  });
})();
