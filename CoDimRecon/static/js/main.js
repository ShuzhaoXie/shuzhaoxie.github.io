/* CoDimRecon project page — page interactions (no dependencies).
   Kept as a classic script so the page still works when opened from disk;
   the 3D viewers live in viewers.js (ES module) and need an HTTP server. */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var hasIO = "IntersectionObserver" in window;

  /* ---------- Nav: shadow on scroll + scrollspy ---------- */
  var nav = $("#nav");
  var onScroll = function () { nav.classList.toggle("is-scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var navLinks = $$(".nav-links a");
  var sections = navLinks
    .map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); })
    .filter(Boolean);
  if (hasIO && sections.length) {
    var visible = new Map();
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0); });
      var best = null;
      var bestRatio = 0;
      sections.forEach(function (s) {
        var r = visible.get(s.id) || 0;
        if (r > bestRatio) { bestRatio = r; best = s.id; }
      });
      navLinks.forEach(function (a) { a.classList.toggle("is-active", best !== null && a.getAttribute("href") === "#" + best); });
    }, { rootMargin: "-45% 0px -50% 0px", threshold: [0, 0.01, 0.5, 1] });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---------- Reveal on scroll ---------- */
  var reveals = $$(".reveal");
  if (hasIO) {
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); revealer.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    reveals.forEach(function (el) { revealer.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- Qualitative comparison tabs ---------- */
  var QUAL = {
    "67d702f2e8": {
      src: "static/images/recon_67d702f2e8.webp", w: 3201, h: 939, name: "ScanNet++ scene 67d702f2e8", holoSceneLabel: "HoloScene",
      caption: "<strong>Qualitative comparison on ScanNet++ scene 67d702f2e8</strong> — rendered appearance (top) and geometry (bottom). To reduce the influence of upstream pose and segmentation errors, HoloScene (official release) and ReplicateAnyScene (our reimplementation) use ScanNet++ SfM camera poses and manually annotated instance masks from the HoloScene release. GPT-6 Astra reconstructs directly from RGB images; CoDimRecon uses camera poses, depth, and instance masks estimated from multi-view RGB images."
    },
    "7831862f02": { src: "static/images/recon_7831862f02.webp", w: 2400, h: 652, name: "ScanNet++ scene 7831862f02", holoSceneLabel: "HoloScene*" },
    "acd69a1746": { src: "static/images/recon_acd69a1746.webp", w: 2400, h: 652, name: "ScanNet++ scene acd69a1746", holoSceneLabel: "HoloScene*" },
    "room_0": { src: "static/images/recon_room_0.webp", w: 2400, h: 978, name: "Replica room_0", holoSceneLabel: "HoloScene*" },
    "room_1": { src: "static/images/recon_room_1.webp", w: 2400, h: 978, name: "Replica room_1", holoSceneLabel: "HoloScene*" },
    "room_2": { src: "static/images/recon_room_2.webp", w: 2400, h: 978, name: "Replica room_2", holoSceneLabel: "HoloScene*" }
  };
  var qualImg = $("#qual-img");
  var qualCaption = $("#qual-caption");
  var qualTabs = $$("#qual-tabs [data-qual]");
  var setQual = function (key) {
    var q = QUAL[key];
    if (!q) return;
    qualTabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.qual === key)); });
    qualCaption.innerHTML = q.caption ||
      "<strong>Qualitative comparison on " + q.name + "</strong> — rendered appearance (top) and geometry (bottom) from the same input view. HoloScene<sup>*</sup> disables normal supervision and uses the same VGGT-Omega camera poses and depth and mask-clustering instance masks as CoDimRecon, all estimated from multi-view RGB images. ReplicateAnyScene is our reimplementation using manually annotated instance masks from the HoloScene release; its quantitative results instead use the default VLM + SAM3 segmentation. GPT-6 Astra reconstructs directly from RGB images.";
    if (qualImg.getAttribute("src") === q.src) return;
    qualImg.classList.add("is-loading");
    var next = new Image();
    next.onload = next.onerror = function () {
      qualImg.src = q.src;
      qualImg.width = q.w;
      qualImg.height = q.h;
      qualImg.alt = "Qualitative comparison on " + q.name + ": rendered appearance (top row) and geometry (bottom row) for ground truth, " + q.holoSceneLabel + ", ReplicateAnyScene, GPT-6 Astra, and CoDimRecon.";
      qualImg.classList.remove("is-loading");
    };
    next.src = q.src;
  };
  qualTabs.forEach(function (t) {
    t.addEventListener("click", function () { setQual(t.dataset.qual); });
    t.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var i = qualTabs.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1);
      var n = qualTabs[(i + qualTabs.length) % qualTabs.length];
      n.focus();
      setQual(n.dataset.qual);
    });
  });
  setQual("67d702f2e8");
  // Warm the cache for the other comparison figures once the page is idle.
  var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };
  idle(function () { Object.keys(QUAL).forEach(function (k) { var i = new Image(); i.src = QUAL[k].src; }); });

  /* ---------- Videos: play only while on screen ---------- */
  var autoVideos = $$(".reel video, .videos video");
  if (hasIO) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting && e.intersectionRatio >= 0.4) {
          if (v.dataset.userPaused === "1") return;
          if (v.preload === "none") v.preload = "auto";
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
        } else if (!v.paused) {
          v.dataset.autoPausing = "1";
          v.pause();
        }
      });
    }, { threshold: [0, 0.4, 0.8] });
    autoVideos.forEach(function (v) {
      v.muted = true;
      vio.observe(v);
      // Respect a pause the viewer made with the controls.
      v.addEventListener("pause", function () {
        if (v.dataset.autoPausing === "1") { v.dataset.autoPausing = ""; return; }
        v.dataset.userPaused = "1";
      });
      v.addEventListener("play", function () { v.dataset.userPaused = ""; });
    });
  }

  /* ---------- Video filter ---------- */
  var filterBtns = $$("#video-filter [data-filter]");
  var cards = $$("#videos .video-card");
  filterBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      var f = b.dataset.filter;
      filterBtns.forEach(function (x) {
        var on = x === b;
        x.classList.toggle("is-active", on);
        x.setAttribute("aria-pressed", String(on));
      });
      cards.forEach(function (c) {
        var show = f === "all" || c.dataset.kind === f;
        c.hidden = !show;
        var v = $("video", c);
        if (!show && v && !v.paused) { v.dataset.autoPausing = "1"; v.pause(); }
      });
    });
  });

  /* ---------- Paper-fold retention bars ---------- */
  var bars = $$("#fold-compare .bar i");
  var fillBars = function () { bars.forEach(function (b) { b.style.width = b.dataset.width + "%"; }); };
  if (hasIO && bars.length) {
    var bio = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { fillBars(); bio.disconnect(); }
    }, { threshold: 0.3 });
    bio.observe($("#fold-compare"));
  } else {
    fillBars();
  }

  /* ---------- Lightbox for dense figures ---------- */
  var lb = $("#lightbox");
  var lbImg = $("img", lb);
  var lastFocus = null;
  var openLB = function (img) {
    lastFocus = document.activeElement;
    lbImg.src = img.currentSrc || img.src;
    lbImg.alt = img.alt;
    lb.classList.add("is-open");
    lb.setAttribute("aria-hidden", "false");
    $(".lightbox-close", lb).focus();
  };
  var closeLB = function () {
    lb.classList.remove("is-open");
    lb.setAttribute("aria-hidden", "true");
    if (lastFocus) lastFocus.focus();
  };
  $$("img.zoomable").forEach(function (img) {
    img.setAttribute("tabindex", "0");
    img.setAttribute("role", "button");
    img.addEventListener("click", function () { openLB(img); });
    img.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLB(img); }
    });
  });
  lb.addEventListener("click", closeLB);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && lb.classList.contains("is-open")) closeLB();
  });

  /* ---------- Copy BibTeX ---------- */
  var copyBtn = $("#copy-bibtex");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var text = $("#bibtex-code").textContent;
      var done = function () {
        var label = $("span", copyBtn);
        label.textContent = "Copied";
        setTimeout(function () { label.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text);
        done();
      }
    });
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (err) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* ---------- Opened from disk: explain why 3D is unavailable ---------- */
  if (location.protocol === "file:") {
    $$("#art-loader, #gallery-loader").forEach(function (loader) {
      $("[data-loader-text]", loader).textContent = "3D viewers need a local web server";
      $("[data-loader-sub]", loader).innerHTML = "Run <code>python3 -m http.server</code> in this folder, then open <code>http://localhost:8000</code>.";
      var bar = $(".loader-bar", loader);
      if (bar) bar.style.display = "none";
    });
  }
})();
