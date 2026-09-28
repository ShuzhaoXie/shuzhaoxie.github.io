/* CoDimRecon project page — interactive 3D viewers.
   1) Articulated office (scene.glb): drag chairs, actuate doors/drawers/lamp.
   2) Scene gallery (models/*.glb): click an object to inspect its isolated mesh.
   3) Physical-property inspector (scene.glb + physics/67d.json): click an object to see its simulation parameters. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sanitize = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

/* ---------------------------------------------------------------- shared */

let draco = null;
function makeLoader() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath("draco/");
    draco.setDecoderConfig({ type: "wasm" });
  }
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (err) {
    return false;
  }
}

function makeRenderer(container, { maxPixelRatio = 1.7, power = "high-performance", exposure = 1.05 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: power });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  container.appendChild(renderer.domElement);
  return renderer;
}

function fitRenderer(renderer, camera, el) {
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}

/* Runs `frame` on rAF only while `el` is on screen and the tab is visible. */
function visibleLoop(el, frame) {
  let onScreen = false;
  let raf = 0;
  let last = 0;
  const tick = (t) => {
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min((t - last) / 1000, 1 / 20) : 1 / 60;
    last = t;
    frame(t, dt);
  };
  const sync = () => {
    const run = onScreen && !document.hidden;
    if (run && !raf) {
      last = 0;
      raf = requestAnimationFrame(tick);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  new IntersectionObserver((entries) => {
    onScreen = entries[0].isIntersecting;
    sync();
  }).observe(el);
  document.addEventListener("visibilitychange", sync);
}

/* Calls `fn` once when `el` comes within `margin` of the viewport. */
function whenNear(el, fn, margin = "500px") {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { rootMargin: margin });
  io.observe(el);
}

function loaderUI(root) {
  const text = root.querySelector("[data-loader-text]");
  const sub = root.querySelector("[data-loader-sub]");
  const bar = root.querySelector("[data-loader-bar]");
  return {
    progress(pct, label, detail) {
      root.classList.remove("is-done");
      if (bar) {
        bar.parentElement.style.display = "";
        bar.style.width = `${pct}%`;
      }
      if (label) text.textContent = label;
      if (detail !== undefined) sub.textContent = detail;
    },
    done() {
      root.classList.add("is-done");
    },
    error(msg, detail = "") {
      root.classList.remove("is-done");
      if (bar) bar.parentElement.style.display = "none";
      text.textContent = msg;
      sub.textContent = detail;
    },
  };
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => {
      Object.values(m).forEach((v) => {
        if (v && v.isTexture) v.dispose();
      });
      m.dispose();
    });
  });
}

function isShown(obj) {
  for (let n = obj; n; n = n.parent) if (!n.visible) return false;
  return true;
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* ============================================================ 1. Articulated office */

function initArticulatedScene() {
  const container = document.getElementById("art-canvas");
  const loaderEl = document.getElementById("art-loader");
  if (!container || !loaderEl) return;
  const ui = loaderUI(loaderEl);
  const hoverEl = document.getElementById("art-hover");
  const deck = document.getElementById("art-deck");
  const resetBtn = document.getElementById("art-reset");
  const overviewBtn = document.getElementById("art-overview");
  const cutawayBtn = document.getElementById("art-cutaway");

  if (!hasWebGL()) {
    ui.error("WebGL is not available in this browser", "The interactive scene needs WebGL.");
    return;
  }

  const ITEMS = {
    chairLeft: "Left office chair",
    chairRight: "Right office chair",
    cabinetLeft: "Left cabinet door",
    cabinetRight: "Right cabinet door",
    drawers: "Drawer units",
    doors: "Room doors",
    lamp: "Desk lamp",
  };
  const CUTAWAY_NODES = ["ceiling", "wall_window", "wall_right", "window", "radiator"];
  const CHAIR_ORIGIN = {
    left: new THREE.Vector3(-0.5255, 0.0057, 0.7935),
    right: new THREE.Vector3(0.3744, 0.0057, -0.6045),
  };
  const VIEWS = {
    overview: { position: new THREE.Vector3(4.25, 3.05, -5.35), target: new THREE.Vector3(0, 1.15, 0.25) },
  };
  const FOCUS = {
    chairLeft: { position: new THREE.Vector3(2.2, 1.45, 2.2), target: new THREE.Vector3(-0.59, 0.62, 0.87) },
    chairRight: { position: new THREE.Vector3(2.45, 2.15, -2.05), target: new THREE.Vector3(0.37, 0.62, -0.6) },
    cabinetLeft: { position: new THREE.Vector3(3.1, 1.8, 0.6), target: new THREE.Vector3(0.96, 0.95, 2.08) },
    cabinetRight: { position: new THREE.Vector3(3.1, 1.8, 0.6), target: new THREE.Vector3(0.96, 0.95, 2.8) },
    drawers: { position: new THREE.Vector3(1.55, 0.78, -0.95), target: new THREE.Vector3(0.68, 0.34, 0.34) },
    doors: { position: new THREE.Vector3(4.1, 2.6, -4.3), target: new THREE.Vector3(-0.15, 1, 1.85) },
    lamp: { position: new THREE.Vector3(2.6, 1.8, -2.4), target: new THREE.Vector3(1.08, 1.15, -1.2) },
  };

  // ---- three.js setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dfe2da");
  scene.fog = new THREE.FogExp2("#dfe2da", 0.025);
  const camera = new THREE.PerspectiveCamera(47, 1, 0.03, 80);
  camera.position.copy(VIEWS.overview.position);
  const renderer = makeRenderer(container);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.copy(VIEWS.overview.target);
  controls.minDistance = 1.2;
  controls.maxDistance = 11;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  scene.add(new THREE.HemisphereLight("#fff5df", "#526157", 2.1));
  const key = new THREE.DirectionalLight("#fff3d5", 3.2);
  key.position.set(-3, 7, -4);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#cbe0ff", 1.4);
  fill.position.set(5, 3, 5);
  scene.add(fill);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.125, 32),
    new THREE.MeshBasicMaterial({ color: "#ef6a3a", depthTest: false, side: THREE.DoubleSide, transparent: true }),
  );
  marker.renderOrder = 100;
  marker.visible = false;
  scene.add(marker);
  let markerUntil = 0;

  const resize = () => fitRenderer(renderer, camera, container);
  new ResizeObserver(resize).observe(container);
  resize();

  // ---- articulation state
  const motions = new Map(); // sanitized node name -> { node, rotationY?, positionY? }
  const dragGroups = {};
  const casters = { left: [], right: [] };
  const interactive = [];
  let root = null;
  let ready = false;

  const setRotation = (name, value) => {
    const m = motions.get(sanitize(name));
    if (m) m.rotationY = value;
  };
  const setRotationNow = (name, value) => {
    const m = motions.get(sanitize(name));
    if (m) {
      m.rotationY = value;
      m.node.rotation.y = value;
    }
  };
  const setPosition = (name, value) => {
    const m = motions.get(sanitize(name));
    if (m) m.positionY = value;
  };

  const rollCasters = (side, delta) => {
    const dist = Math.hypot(delta.x, delta.z);
    if (dist < 1e-4) return;
    const dir = delta.clone().setY(0).normalize();
    casters[side].forEach((c) => {
      const cross = c.baseDirection.z * dir.x - c.baseDirection.x * dir.z;
      const angle = Math.atan2(cross, c.baseDirection.dot(dir));
      c.spin += dist / 0.031;
      setRotationNow(c.steer, angle);
      c.wheels.forEach((w) => setRotationNow(w, c.spin));
    });
  };
  const resetCasters = () => {
    ["left", "right"].forEach((side) =>
      casters[side].forEach((c) => {
        c.spin = 0;
        setRotationNow(c.steer, 0);
        c.wheels.forEach((w) => setRotationNow(w, 0));
      }),
    );
  };

  const api = {
    setChairAngle(side, deg) {
      setRotation(`ART.control.chair_${side}.swivel_lift.motion0`, THREE.MathUtils.degToRad(deg * (side === "left" ? 1 : -1)));
    },
    setLampJoint(joint, deg) {
      const r = THREE.MathUtils.degToRad(deg);
      if (joint === "lower" || joint === "upper") {
        setRotation(`ART.control.lamp_right.${joint}_swing.motion0`, r);
        setRotation(`ART.control.lamp_right.${joint}_follower.motion0`, r);
        setRotation(`ART.control.lamp_right.${joint}_counter.motion0`, -r);
      } else {
        setRotation("ART.control.lamp_right.head_tilt.motion0", r);
      }
    },
    setDrawer(side, index, pct) {
      const travel = 0.2 + index * 0.055 + (side === "right" ? 0.02 : 0);
      setPosition(`ART.control.pedestal_${side}.drawer${index}.motion0`, (pct / 100) * travel);
    },
    setToggle(keyName, on) {
      if (keyName === "cabinetLeft") setRotation("ART.control.cabinet_tall.hinge1.motion0", on ? 1.2 : 0);
      else if (keyName === "cabinetRight") setRotation("ART.control.cabinet_tall.hinge0.motion0", on ? 1.2 : 0);
      else if (keyName === "doors") {
        setRotation("ART.control.door_left.hinge.motion0", on ? -1.05 : 0);
        setRotation("ART.control.door_rear.hinge.motion0", on ? -0.95 : 0);
      }
    },
    setCutaway(on) {
      if (!root) return;
      CUTAWAY_NODES.forEach((n) => {
        const o = root.getObjectByName(n);
        if (o) o.visible = !on;
      });
    },
  };

  // Smooth camera moves
  const fly = { active: false, position: VIEWS.overview.position.clone(), target: VIEWS.overview.target.clone() };
  controls.addEventListener("start", () => { fly.active = false; });
  const flyTo = (view, withMarker) => {
    fly.active = true;
    fly.position.copy(view.position);
    fly.target.copy(view.target);
    if (withMarker) {
      marker.position.copy(view.target);
      markerUntil = performance.now() + 1600;
    }
  };

  // ---- which articulated group does a mesh belong to?
  const classify = (obj) => {
    const names = [];
    for (let n = obj; n; n = n.parent) names.push(n.name);
    const s = names.join(" ");
    if (s.includes("cabinet_tall") && s.includes("door1")) return "cabinetLeft";
    if (s.includes("cabinet_tall") && s.includes("door0")) return "cabinetRight";
    if (s.includes("pedestal_left") || s.includes("pedestal_right")) return "drawers";
    if (s.includes("chair_left")) return "chairLeft";
    if (s.includes("chair_right")) return "chairRight";
    if (s.includes("door_left") || s.includes("door_rear")) return "doors";
    if (s.includes("lamp_right")) return "lamp";
    return null;
  };

  // ---- deck UI
  const state = {
    toggles: { cabinetLeft: false, cabinetRight: false, doors: false },
    chairMoved: { left: false, right: false },
    chairAngle: { left: 0, right: 0 },
    drawers: { left: [0, 0, 0], right: [0, 0, 0] },
    lamp: { lower: 0, upper: 0, head: 0 },
    open: null,
    cutaway: true,
  };
  const itemEl = (k) => deck.querySelector(`[data-item="${k}"]`);

  const refreshActive = () => {
    const active = {
      chairLeft: state.chairMoved.left || state.chairAngle.left !== 0,
      chairRight: state.chairMoved.right || state.chairAngle.right !== 0,
      cabinetLeft: state.toggles.cabinetLeft,
      cabinetRight: state.toggles.cabinetRight,
      doors: state.toggles.doors,
      drawers: [...state.drawers.left, ...state.drawers.right].some((v) => v !== 0),
      lamp: Object.values(state.lamp).some((v) => v !== 0),
    };
    Object.keys(active).forEach((k) => {
      const el = itemEl(k);
      el.classList.toggle("is-active", active[k]);
      const toggleBtn = el.querySelector("[data-toggle]");
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-pressed", String(active[k]));
        const label = toggleBtn.querySelector(".deck-action");
        label.textContent = active[k] ? label.dataset.on : label.dataset.off;
      }
    });
  };

  const openPanel = (k, { focus = false } = {}) => {
    state.open = state.open === k ? null : k;
    deck.querySelectorAll("[data-panel]").forEach((btn) => {
      const on = btn.dataset.panel === state.open;
      btn.setAttribute("aria-expanded", String(on));
      btn.nextElementSibling.hidden = !on;
      btn.querySelector(".deck-action").textContent = on ? "Hide" : "Adjust";
    });
    if (state.open && focus) flyTo(FOCUS[k], true);
    if (state.open) {
      const el = itemEl(state.open);
      // keep the opened panel visible inside the scrollable deck
      requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" }));
    }
  };

  const toggle = (k, { focus = false } = {}) => {
    state.toggles[k] = !state.toggles[k];
    api.setToggle(k, state.toggles[k]);
    if (focus || k === "doors") flyTo(FOCUS[k], true);
    refreshActive();
  };

  // Scene click / deck click dispatch
  const activate = (k, fromScene) => {
    if (k in state.toggles) toggle(k, { focus: !fromScene });
    else openPanel(k, { focus: !fromScene });
  };

  deck.querySelectorAll("[data-panel]").forEach((btn) =>
    btn.addEventListener("click", () => activate(btn.dataset.panel, false)),
  );
  deck.querySelectorAll("[data-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => activate(btn.dataset.toggle, false)),
  );
  const syncOutput = (input, suffix) => {
    input.nextElementSibling.textContent = `${input.value}${suffix}`;
  };
  deck.querySelectorAll("[data-chair]").forEach((input) =>
    input.addEventListener("input", () => {
      const side = input.dataset.chair;
      state.chairAngle[side] = Number(input.value);
      api.setChairAngle(side, state.chairAngle[side]);
      syncOutput(input, "°");
      refreshActive();
    }),
  );
  deck.querySelectorAll("[data-drawer]").forEach((input) =>
    input.addEventListener("input", () => {
      const side = input.dataset.drawer;
      const idx = Number(input.dataset.index);
      state.drawers[side][idx] = Number(input.value);
      api.setDrawer(side, idx, state.drawers[side][idx]);
      syncOutput(input, "%");
      refreshActive();
    }),
  );
  deck.querySelectorAll("[data-lamp]").forEach((input) =>
    input.addEventListener("input", () => {
      const j = input.dataset.lamp;
      state.lamp[j] = Number(input.value);
      api.setLampJoint(j, state.lamp[j]);
      syncOutput(input, "°");
      refreshActive();
    }),
  );

  const resetAll = () => {
    Object.keys(state.toggles).forEach((k) => {
      state.toggles[k] = false;
      api.setToggle(k, false);
    });
    ["left", "right"].forEach((side) => {
      state.chairAngle[side] = 0;
      state.chairMoved[side] = false;
      api.setChairAngle(side, 0);
      state.drawers[side] = [0, 0, 0];
      [0, 1, 2].forEach((i) => api.setDrawer(side, i, 0));
      if (dragGroups[side]) dragGroups[side].position.set(0, 0, 0);
    });
    Object.keys(state.lamp).forEach((j) => {
      state.lamp[j] = 0;
      api.setLampJoint(j, 0);
    });
    resetCasters();
    deck.querySelectorAll('input[type="range"]').forEach((input) => {
      input.value = 0;
      syncOutput(input, input.dataset.drawer ? "%" : "°");
    });
    if (state.open) openPanel(state.open);
    flyTo(VIEWS.overview, false);
    refreshActive();
  };
  resetBtn.addEventListener("click", resetAll);
  overviewBtn.addEventListener("click", () => flyTo(VIEWS.overview, false));
  cutawayBtn.addEventListener("click", () => {
    state.cutaway = !state.cutaway;
    api.setCutaway(state.cutaway);
    cutawayBtn.setAttribute("aria-pressed", String(!state.cutaway));
    cutawayBtn.textContent = state.cutaway ? "Show complete room" : "Return to cutaway";
  });

  // ---- pointer interaction: hover labels, chair dragging, click to actuate
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.0057);
  const hit = new THREE.Vector3();
  let drag = null;
  let downAt = { x: 0, y: 0 };
  let hoverText = "";
  let hoverRaf = 0;

  const setRay = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
  };
  // Only articulated meshes are ray-tested: the full scene has ~1,300 meshes.
  const pick = (e) => {
    if (!interactive.length) return null;
    setRay(e);
    const h = raycaster.intersectObjects(interactive, false).find((x) => isShown(x.object));
    return h ? h.object.userData.interaction : null;
  };
  const showHover = (text) => {
    if (text === hoverText) return;
    hoverText = text;
    hoverEl.textContent = text;
    hoverEl.classList.toggle("is-visible", !!text);
  };

  renderer.domElement.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY };
    if (!ready) return;
    const k = pick(e);
    if (k !== "chairLeft" && k !== "chairRight") return;
    const side = k === "chairLeft" ? "left" : "right";
    const group = dragGroups[side];
    if (!group || !raycaster.ray.intersectPlane(floor, hit)) return;
    drag = { side, pointerId: e.pointerId, start: hit.clone(), startPos: group.position.clone(), moved: false };
    fly.active = false;
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    renderer.domElement.style.cursor = "grabbing";
    e.preventDefault();
  }, true);

  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!ready) return;
    if (drag && e.pointerId === drag.pointerId) {
      setRay(e);
      const group = dragGroups[drag.side];
      if (group && raycaster.ray.intersectPlane(floor, hit)) {
        const d = hit.clone().sub(drag.start);
        const o = CHAIR_ORIGIN[drag.side];
        const before = group.position.clone();
        group.position.x = THREE.MathUtils.clamp(drag.startPos.x + d.x, -1.25 - o.x, 1.35 - o.x);
        group.position.z = THREE.MathUtils.clamp(drag.startPos.z + d.z, -1.45 - o.z, 1.75 - o.z);
        rollCasters(drag.side, group.position.clone().sub(before));
        if (!drag.moved) drag.moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5;
        showHover(`Dragging · ${ITEMS[drag.side === "left" ? "chairLeft" : "chairRight"]}`);
      }
      return;
    }
    if (e.buttons !== 0 || hoverRaf) return;
    const ev = { clientX: e.clientX, clientY: e.clientY };
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const k = pick(ev);
      const isChair = k === "chairLeft" || k === "chairRight";
      showHover(k ? (isChair ? `Hold and drag · ${ITEMS[k]}` : `Click · ${ITEMS[k]}`) : "");
      renderer.domElement.style.cursor = isChair ? "grab" : k ? "pointer" : "grab";
    });
  });

  const endDrag = (e, cancelled) => {
    const d = drag;
    drag = null;
    controls.enabled = true;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    renderer.domElement.style.cursor = "grab";
    if (cancelled) return;
    const k = d.side === "left" ? "chairLeft" : "chairRight";
    if (d.moved) {
      state.chairMoved[d.side] = true;
      refreshActive();
    } else {
      activate(k, true);
    }
  };

  renderer.domElement.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.pointerId) {
      endDrag(e, false);
      return;
    }
    if (!ready || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 7) return;
    const k = pick(e);
    if (k) activate(k, true);
  });
  renderer.domElement.addEventListener("pointercancel", (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(e, true);
  });
  renderer.domElement.addEventListener("pointerleave", () => { if (!drag) showHover(""); });

  // ---- render loop
  visibleLoop(container, (t) => {
    motions.forEach((m) => {
      if (m.rotationY !== undefined) m.node.rotation.y = THREE.MathUtils.lerp(m.node.rotation.y, m.rotationY, 0.045);
      if (m.positionY !== undefined) m.node.position.y = THREE.MathUtils.lerp(m.node.position.y, m.positionY, 0.055);
    });
    if (fly.active) {
      camera.position.lerp(fly.position, 0.11);
      controls.target.lerp(fly.target, 0.11);
      if (camera.position.distanceTo(fly.position) < 0.015 && controls.target.distanceTo(fly.target) < 0.015) fly.active = false;
    }
    marker.visible = t < markerUntil;
    if (marker.visible) {
      marker.quaternion.copy(camera.quaternion);
      marker.scale.setScalar(1 + Math.sin(t * 0.012) * 0.16);
    }
    controls.update();
    renderer.render(scene, camera);
  });

  // ---- load on approach
  const load = () => {
    ui.progress(2, "Loading the reconstructed office", "Fetching geometry and materials…");
    makeLoader().load(
      "scene.glb",
      (gltf) => {
        root = gltf.scene;
        // Chairs move as whole assemblies: gather each chair into a drag group.
        ["left", "right"].forEach((side) => {
          const group = new THREE.Group();
          group.name = `WEB.chair_${side}.drag_group`;
          [...root.children]
            .filter((child) => {
              let match = false;
              child.traverse((n) => { if (n.name.includes(`chair_${side}`)) match = true; });
              return match;
            })
            .forEach((child) => group.add(child));
          root.add(group);
          dragGroups[side] = group;
        });
        root.traverse((n) => {
          if (n.name.endsWith("motion0") || n.name.endsWith("motion1")) motions.set(n.name, { node: n });
          if (n.isMesh) {
            n.userData.interaction = classify(n);
            if (n.userData.interaction) interactive.push(n);
          }
        });
        if (motions.size === 0) {
          ui.error("Articulation data failed to load", "Please refresh the page.");
          return;
        }
        scene.add(root);
        root.updateMatrixWorld(true);

        ["left", "right"].forEach((side) => {
          for (let i = 0; i < 5; i += 1) {
            const steer = `ART.control.chair_${side}.caster${i}_steer.motion0`;
            const wheels = [`ART.control.chair_${side}.caster${i}_wheel0.motion0`, `ART.control.chair_${side}.caster${i}_wheel1.motion0`];
            const wheel = root.getObjectByName(sanitize(wheels[0]));
            if (!wheel || !wheel.parent) continue;
            const axle = new THREE.Vector3(0, 1, 0).applyQuaternion(wheel.parent.getWorldQuaternion(new THREE.Quaternion()));
            const baseDirection = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), axle).setY(0).normalize();
            if (baseDirection.lengthSq() > 0.5) casters[side].push({ steer, wheels, baseDirection, spin: 0 });
          }
        });

        api.setCutaway(true);
        ready = true;
        deck.querySelectorAll("button").forEach((b) => { b.disabled = false; });
        resetBtn.disabled = false;
        ui.done();
      },
      (xhr) => {
        if (xhr.total > 0) {
          const pct = Math.min(96, Math.round((xhr.loaded / xhr.total) * 96));
          ui.progress(pct, "Loading the reconstructed office", `${formatMB(xhr.loaded)} of ${formatMB(xhr.total)}${pct >= 96 ? " · decoding meshes…" : ""}`);
        }
      },
      (err) => {
        console.error("Failed to load scene.glb", err);
        ui.error("The scene failed to load", "Please refresh the page.");
      },
    );
  };
  whenNear(container, load);
}

/* ============================================================ 2. Scene gallery */

/* Semantic labels for exported object names (ported from the original viewer). */
function isShell(name) {
  const t = name.toLowerCase();
  return t.startsWith("ceiling") || t.startsWith("wall_") || t.startsWith("wall.") || t.startsWith("wall__");
}

const LABELS = [
  [/throw_bed/, "Bed Throw", "Bedding textile"],
  [/throw_basket/, "Folded Throw", "Soft object"],
  [/duvet|comforter|coverlet|quilt/, "Duvet", "Bedding textile"],
  [/mattress/, "Mattress", "Bedding"],
  [/bed[_ .-]*(?:sheet|linen)|(?:sheet|linen)[_ .-]*bed|bedding/, "Bed Sheet", "Bedding textile"],
  [/headboard/, "Headboard", "Furniture"],
  [/pillow/, "Pillow", "Soft object"],
  [/blanket/, "Blanket", "Soft object"],
  [/console_papers/, "Paper Stack", "Loose object"],
  [/(?:^|[_ .-])book(?:[_ .-]|$)/, "Book", "Loose object"],
  [/mug/, "Mug", "Tabletop object"],
  [/table_planter/, "Table Planter", "Tabletop plant"],
  [/table_leaf_tray/, "Leaf Tray", "Tabletop object"],
  [/vase_blue/, "Blue Vase", "Tabletop object"],
  [/planter_tall/, "Tall Planter", "Plant"],
  [/beanbag/, "Beanbag", "Soft object"],
  [/armchair/, "Armchair", "Seating"],
  [/cushion/, "Cushion", "Soft object"],
  [/stool/, "Stool", "Seating"],
  [/chair/, "Chair", "Seating"],
  [/pedestal.*drawer|drawer.*pedestal/, "Drawer Pedestal", "Storage"],
  [/drawer/, "Drawer", "Storage"],
  [/wardrobe/, "Wardrobe", "Storage"],
  [/cabinet|facade/, "Cabinet", "Storage"],
  [/bookshelf|shelf/, "Shelving", "Storage"],
  [/bench/, "Bench", "Seating"],
  [/sofa|couch/, "Sofa", "Seating"],
  [/desk/, "Desk", "Furniture"],
  [/table/, "Table", "Furniture"],
  [/bed/, "Bed", "Furniture"],
  [/vase_foliage|plant|planter/, "Potted Plant", "Decoration"],
  [/window.*blind|blind.*window/, "Window Blind", "Window treatment"],
  [/whiteboard/, "Whiteboard", "Wall fixture"],
  [/projector/, "Projector", "Equipment"],
  [/monitor|display/, "Display", "Equipment"],
  [/telephone|phone/, "Telephone", "Equipment"],
  [/pendant/, "Pendant Light", "Lighting"],
  [/spotlight/, "Spotlight", "Lighting"],
  [/diffuser/, "Ceiling Diffuser", "Ceiling fixture"],
  [/(^|[._-])light([._-]|$)|lamp/, "Light", "Lighting"],
  [/painting|picture|artwork/, "Wall Art", "Decoration"],
  [/extinguisher/, "Fire Extinguisher", "Safety equipment"],
  [/lectern/, "Lectern", "Furniture"],
  [/console/, "Console", "Furniture"],
  [/remote/, "Remote Control", "Equipment"],
  [/paper|folder|note/, "Paper Material", "Loose object"],
  [/coat/, "Coat", "Soft object"],
  [/tote|(^|[._-])bag([._-]|$)/, "Bag", "Soft object"],
  [/cube_/, "Cube Seat", "Seating"],
  [/divider/, "Room Divider", "Architecture"],
  [/window/, "Window", "Architecture"],
  [/(^|[._-])door([._-]|$)/, "Door", "Architecture"],
  [/ceiling/, "Ceiling", "Architecture"],
  [/wall/, "Wall", "Architecture"],
  [/floor|carpet/, "Floor", "Architecture"],
  [/rug/, "Rug", "Soft object"],
];

function semanticLabel(name) {
  const t = name.toLowerCase();
  const m = LABELS.find(([re]) => re.test(t));
  if (m) return { name: m[1], kind: m[2] };
  const pretty = name
    .replace(/^ART\.(?:ctrl|part)\./i, "")
    .replace(/^ART\.|^geo\./i, "")
    .split("__")[0]
    .split(".")[0]
    .replace(/(?:^|[_-])(?:part|mesh|motion|axis|geometry)(?:[_-]?\d+)?/gi, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name: pretty && !/^(cube|cylinder|plane|sphere|mesh)$/i.test(pretty) ? pretty : "Reconstructed Object",
    kind: "Scene object",
  };
}

const GENERIC_PART = /^(?:body|foot|feet|handle|rim|seam|piping|branch|lever|cantilever|offset[_ .-]*stem|curved[_ .-]*bracket|metal[_ .-]*lug(?:[_ .-]*-?\d+)?|mesh|geometry|part(?:[_ .-]*\d+)?)$/i;

function meaningfulName(obj) {
  for (let n = obj; n; n = n.parent) {
    const name = n.name.trim();
    const base = name.split("__")[0].split(".")[0];
    if (name && !GENERIC_PART.test(base)) return name;
  }
  return obj.name;
}

function groupKey(name) {
  const art = /^ART\.(?:ctrl|part)\./i.test(name);
  const n = name.replace(/^ART\.(?:ctrl|part)\./i, "").replace(/^ART\./i, "").replace(/^geo\./i, "");
  if (n.includes("__")) return n.split("__")[0];
  return art ? n.split(".").slice(0, 2).join(".") : n.split(".")[0].replace(/\.\d+$/, "");
}

function addGalleryLights(scene) {
  scene.add(new THREE.HemisphereLight(0xfffbef, 0x28342f, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 9, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb9d2ff, 1.1);
  fill.position.set(-6, 3, -4);
  scene.add(fill);
}

/* Bounds of the meshes that are actually drawn (ignores hidden walls/ceilings). */
function shownBounds(obj) {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (o.isMesh && isShown(o)) box.expandByObject(o, false);
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(obj) : box;
}

function frameObject(camera, obj, controls, distanceScale = 1.35, isRoom = false) {
  const box = shownBounds(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Rooms: aim below mid-height so the furniture, not the ceiling fixtures, sits in the middle.
  if (isRoom) center.y = box.min.y + size.y * 0.3;
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const dist = (maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * distanceScale;
  camera.position.copy(center).add(new THREE.Vector3(1.2, 0.82, 1.25).normalize().multiplyScalar(dist));
  camera.near = Math.max(dist / 1000, 0.005);
  camera.far = dist * 30;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = maxDim * 0.08;
  controls.maxDistance = dist * 4;
  controls.update();
}

/* Small auto-rotating preview of the selected object's meshes. */
function createObjectPreview(container, meshes) {
  const scene = new THREE.Scene();
  addGalleryLights(scene);
  const group = new THREE.Group();
  meshes.forEach((mesh) => {
    mesh.updateWorldMatrix(true, false);
    const clone = mesh.clone(false);
    clone.matrix.copy(mesh.matrixWorld);
    clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
    clone.visible = true;
    group.add(clone);
  });
  scene.add(group);
  const center = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  group.position.sub(center);
  group.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = !REDUCED_MOTION;
  controls.autoRotateSpeed = 1.1;
  frameObject(camera, group, controls);

  const resize = () => fitRenderer(renderer, camera, container);
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}

function initSceneGallery() {
  const container = document.getElementById("gallery-canvas");
  const loaderEl = document.getElementById("gallery-loader");
  if (!container || !loaderEl) return;
  const ui = loaderUI(loaderEl);
  const loaderImg = loaderEl.querySelector("[data-loader-img]");
  const dot = document.getElementById("gallery-dot");
  const inspect = document.getElementById("gallery-inspect");
  const cutawayBtn = document.getElementById("gallery-cutaway");
  const picker = document.getElementById("scene-picker");
  const thumbs = [...picker.querySelectorAll(".scene-thumb")];
  const titleEl = document.getElementById("gallery-title");
  const eyebrowEl = document.getElementById("gallery-eyebrow");
  const descEl = document.getElementById("gallery-desc");
  const metaEl = document.getElementById("gallery-meta");

  if (!hasWebGL()) {
    ui.error("WebGL is not available in this browser", "The 3D scene viewer needs WebGL.");
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dedfd9");
  addGalleryLights(scene);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
  const renderer = makeRenderer(container, { maxPixelRatio: 1.75, exposure: 1.08 });
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;

  const resize = () => fitRenderer(renderer, camera, container);
  new ResizeObserver(resize).observe(container);
  resize();

  let current = null; // loaded gltf scene
  let meshes = [];
  let cutaway = true;
  let loadToken = 0;
  let closePreview = null;
  let started = false;

  const applyCutaway = () => {
    if (!current) return;
    current.traverse((o) => {
      o.visible = cutaway && isShell(o.name) ? false : o.userData.originalVisible !== false;
    });
  };

  const hideInspect = () => {
    inspect.hidden = true;
    if (closePreview) {
      closePreview();
      closePreview = null;
    }
  };
  inspect.querySelector(".inspect-close").addEventListener("click", hideInspect);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !inspect.hidden) hideInspect(); });

  cutawayBtn.addEventListener("click", () => {
    cutaway = !cutaway;
    cutawayBtn.setAttribute("aria-pressed", String(cutaway));
    applyCutaway();
  });

  const loadScene = (thumb) => {
    const token = ++loadToken;
    hideInspect();
    thumbs.forEach((t) => t.setAttribute("aria-selected", String(t === thumb)));
    titleEl.textContent = thumb.dataset.title;
    eyebrowEl.textContent = thumb.dataset.dataset;
    descEl.textContent = thumb.dataset.desc;
    metaEl.textContent = "";
    if (loaderImg) loaderImg.src = thumb.dataset.preview;
    ui.progress(2, `Loading ${thumb.dataset.title}`, "Fetching geometry and materials…");

    makeLoader().load(
      thumb.dataset.model,
      (gltf) => {
        if (token !== loadToken) {
          disposeObject(gltf.scene);
          return;
        }
        if (current) {
          scene.remove(current);
          disposeObject(current);
        }
        current = gltf.scene;
        meshes = [];
        current.traverse((o) => {
          o.userData.originalVisible = o.visible;
          if (o.isMesh) {
            meshes.push(o);
            o.geometry.computeBoundingSphere();
          }
        });
        applyCutaway();
        scene.add(current);
        current.updateMatrixWorld(true);
        frameObject(camera, current, controls, 1.15, true);
        const json = gltf.parser.json;
        metaEl.innerHTML = `<strong>${(json.meshes || []).length.toLocaleString()}</strong> meshes · <strong>${(json.materials || []).length.toLocaleString()}</strong> materials`;
        ui.done();
      },
      (xhr) => {
        if (token !== loadToken || !(xhr.total > 0)) return;
        const pct = Math.min(96, Math.round((xhr.loaded / xhr.total) * 96));
        ui.progress(pct, `Loading ${thumb.dataset.title}`, `${formatMB(xhr.loaded)} of ${formatMB(xhr.total)}${pct >= 96 ? " · decoding meshes…" : ""}`);
      },
      (err) => {
        if (token !== loadToken) return;
        console.error("Failed to load", thumb.dataset.model, err);
        ui.error("The reconstruction could not be loaded", "Please refresh the page.");
      },
    );
  };

  thumbs.forEach((t) =>
    t.addEventListener("click", () => {
      if (t.getAttribute("aria-selected") === "true" && current) return;
      started = true;
      loadScene(t);
    }),
  );

  // ---- hover marker + click-to-inspect
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = { x: 0, y: 0 };
  let hoverRaf = 0;
  const cast = (x, y) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((x - r.left) / r.width) * 2 - 1;
    ndc.y = -((y - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return { rect: r, hit: raycaster.intersectObjects(meshes.filter(isShown), false)[0] };
  };

  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.buttons !== 0) {
      dot.classList.remove("is-visible");
      return;
    }
    if (hoverRaf || !current) return;
    const { clientX, clientY } = e;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const { rect, hit } = cast(clientX, clientY);
      if (!hit) {
        dot.classList.remove("is-visible");
        renderer.domElement.style.cursor = "grab";
        return;
      }
      dot.style.left = `${clientX - rect.left}px`;
      dot.style.top = `${clientY - rect.top}px`;
      dot.classList.add("is-visible");
      renderer.domElement.style.cursor = "pointer";
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    dot.classList.remove("is-visible");
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!current || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const { rect, hit } = cast(e.clientX, e.clientY);
    if (!hit) {
      hideInspect();
      return;
    }
    const name = meaningfulName(hit.object);
    const label = semanticLabel(name);
    const k = groupKey(name);
    const group = meshes.filter((m) => m.visible && groupKey(meaningfulName(m)) === k);

    hideInspect();
    inspect.querySelector("[data-inspect-name]").textContent = label.name;
    inspect.querySelector("[data-inspect-kind]").textContent = `${label.kind} · ${titleEl.textContent}`;
    inspect.hidden = false;
    const w = inspect.offsetWidth;
    const h = inspect.offsetHeight;
    const x = THREE.MathUtils.clamp(e.clientX - rect.left + 18, 12, Math.max(rect.width - w - 12, 12));
    const y = THREE.MathUtils.clamp(e.clientY - rect.top - 42, 12, Math.max(rect.height - h - 64, 12));
    inspect.style.left = `${x}px`;
    inspect.style.top = `${y}px`;
    closePreview = createObjectPreview(inspect.querySelector("[data-inspect-preview]"), group.length ? group : [hit.object]);
  });

  visibleLoop(container, () => {
    controls.update();
    renderer.render(scene, camera);
  });

  whenNear(container, () => {
    if (!started) loadScene(thumbs.find((t) => t.getAttribute("aria-selected") === "true") || thumbs[0]);
  });
}

/* ============================================================ 3. Physical-property inspector */

const PHYS_TYPE = {
  static: { label: "Static", tag: "static" },
  rigid: { label: "Rigid", tag: "rigid" },
  articulated: { label: "Articulated", tag: "artic" },
  curve: { label: "Curve", tag: "curve" },
  surface: { label: "Surface", tag: "surface" },
  volume: { label: "Volume", tag: "volume" },
};
const PHYS_COLOR = { articulated: "#4d6a86", curve: "#c8662f", surface: "#6c56c2", volume: "#23806c" };
const SIM_COLOR = { ...PHYS_COLOR, collision: "#34405a" };
const JOINT_TYPE = { revolute: "Revolute", prismatic: "Prismatic", cylindrical: "Cylindrical", screw: "Screw" };
const SUPERSCRIPT = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };

const sig = (x, n = 3) => String(Number(x.toPrecision(n))).replace("-", "−");
const fmt = {
  mass: (kg) => (kg < 1 ? `${sig(kg * 1000)} g` : `${sig(kg)} kg`),
  modulus: (pa) => (pa >= 1e9 ? `${sig(pa / 1e9)} GPa` : pa >= 1e6 ? `${sig(pa / 1e6)} MPa` : pa >= 1e3 ? `${sig(pa / 1e3)} kPa` : `${sig(pa)} Pa`),
  mm: (m) => `${sig(m * 1000)} mm`,
  pressure: (pa) => (pa >= 1e3 ? `${sig(pa / 1e3, 4)} kPa` : `${sig(pa)} Pa`),
  deg: (rad) => `${sig(THREE.MathUtils.radToDeg(rad))}°`,
  pow10: (x) => {
    const e = Math.floor(Math.log10(x));
    const m = x / 10 ** e;
    const p = `10${String(e).replace(/[-\d]/g, (c) => SUPERSCRIPT[c])}`;
    return Math.abs(m - 1) < 1e-9 ? p : `${sig(m)}×${p}`;
  },
};
const prettyPart = (s) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function fmtAngleRange(a, b) {
  return Math.abs(a + b) < 1e-9 && b > 0 ? `±${fmt.deg(b)}` : `${fmt.deg(a)} to ${fmt.deg(b)}`;
}
function fmtLinearRange(a, b) {
  return Math.abs(a + b) < 1e-12 && b > 0 ? `±${fmt.mm(b)}` : `${sig(a * 1000)} to ${fmt.mm(b)}`;
}
function fmtJointRange(j) {
  const L = j.limit;
  if (!L) return "—";
  if (j.type === "prismatic") return fmtLinearRange(L[0], L[1]);
  if (j.type === "cylindrical") return `${fmtAngleRange(L[0], L[1])} · ${fmtLinearRange(L[2], L[3])}`;
  if (j.type === "screw") return `${fmtAngleRange(L[0], L[1])} · ${fmt.mm(j.pitch_m_per_turn)} per turn`;
  return fmtAngleRange(L[0], L[1]);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* Fills a <dl> with [label, value, note?] rows, skipping empty values. */
function fillRows(dl, rows) {
  dl.replaceChildren();
  rows.forEach(([k, v, note]) => {
    if (v === undefined || v === null) return;
    dl.append(el("dt", "", k));
    const dd = el("dd", "", v);
    if (note) dd.append(" ", el("small", "", note));
    dl.append(dd);
  });
  return dl;
}

function materialRows(m) {
  const curved = m.naturally_curved == null ? null : m.naturally_curved ? "Curved, the reconstructed shape is stress-free" : "Straight";
  return [
    ["Model", m.model],
    ["Material", m.name],
    ["Young's modulus E", m.youngs_modulus != null ? fmt.modulus(m.youngs_modulus) : null],
    ["Bending modulus", m.bending_youngs_modulus != null ? fmt.modulus(m.bending_youngs_modulus) : null],
    ["Twisting modulus", m.twist_youngs_modulus != null ? fmt.modulus(m.twist_youngs_modulus) : null],
    ["Poisson's ratio ν", m.poisson_ratio != null ? sig(m.poisson_ratio) : null],
    ["Density ρ", m.density != null ? `${sig(m.density, 4)} kg/m³` : null],
    ["Radius r", m.radius != null ? fmt.mm(m.radius) : null],
    ["Thickness h", m.thickness != null ? fmt.mm(m.thickness) : null],
    ["Yield curvature κY", m.yield_curvature != null ? `${sig(m.yield_curvature)} m⁻¹` : null],
    ["Natural shape", curved],
    ["Rigidity penalty", m.rigidity_penalty != null ? `${fmt.pow10(m.rigidity_penalty)} Pa` : null],
  ];
}

function gasRows(g) {
  return [
    ["Model", g.model],
    ["Atmospheric pressure", g.p_atm_pa != null ? fmt.pressure(g.p_atm_pa) : null],
    ["Initial gauge pressure", g.p_gauge0_pa != null ? fmt.pressure(g.p_gauge0_pa) : null],
    ["Polytropic exponent γ", g.gamma != null ? sig(g.gamma) : null],
    ["Reference volume", g.reference_volume_m3 != null ? `${sig(g.reference_volume_m3 * 1000)} L` : null],
  ];
}

const jointCount = (o) => (o.joints || []).reduce((n, j) => n + (j.count || 1), 0);

/* Symmetric 3x3 eigen-decomposition (cyclic Jacobi). Returns eigenvalues and column eigenvectors. */
function eigenSym3(A) {
  const a = A.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep += 1) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-16) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = V[k][p];
        const vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: V };
}

/* Equivalent inertia ellipsoid of `meshes` (world space) for total `mass`, assuming uniform density:
   a solid ellipsoid with the same mass, centre of mass, and principal moments. Signed-tetrahedron
   volume integrals; falls back to the bounding box when the meshes do not enclose a volume. */
function inertiaEllipsoid(meshes, mass) {
  const ref = shownBounds(meshes[0]).getCenter(new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let V = 0;
  const F = [0, 0, 0];
  const S = [0, 0, 0, 0, 0, 0]; // xx yy zz xy xz yz
  meshes.forEach((m) => {
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const mw = m.matrixWorld;
    let v = 0;
    const f = [0, 0, 0];
    const q = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i + 2 < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mw).sub(ref);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mw).sub(ref);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mw).sub(ref);
      const vol = (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
      const sx = a.x + b.x + c.x;
      const sy = a.y + b.y + c.y;
      const sz = a.z + b.z + c.z;
      const w = vol / 20;
      v += vol;
      f[0] += (vol * sx) / 4;
      f[1] += (vol * sy) / 4;
      f[2] += (vol * sz) / 4;
      q[0] += w * (a.x * a.x + b.x * b.x + c.x * c.x + sx * sx);
      q[1] += w * (a.y * a.y + b.y * b.y + c.y * c.y + sy * sy);
      q[2] += w * (a.z * a.z + b.z * b.z + c.z * c.z + sz * sz);
      q[3] += w * (a.x * a.y + b.x * b.y + c.x * c.y + sx * sy);
      q[4] += w * (a.x * a.z + b.x * b.z + c.x * c.z + sx * sz);
      q[5] += w * (a.y * a.z + b.y * b.z + c.y * c.z + sy * sz);
    }
    const sign = v < 0 ? -1 : 1; // tolerate inward-facing normals per mesh
    V += sign * v;
    for (let k = 0; k < 3; k += 1) F[k] += sign * f[k];
    for (let k = 0; k < 6; k += 1) S[k] += sign * q[k];
  });

  const box = new THREE.Box3();
  meshes.forEach((m) => box.expandByObject(m, false));
  const size = box.getSize(new THREE.Vector3());
  let center;
  let J;
  let solid = V > 1e-4 * size.x * size.y * size.z;
  if (solid) {
    const g = F.map((x) => x / V);
    const Sc = [
      S[0] - V * g[0] * g[0], S[1] - V * g[1] * g[1], S[2] - V * g[2] * g[2],
      S[3] - V * g[0] * g[1], S[4] - V * g[0] * g[2], S[5] - V * g[1] * g[2],
    ];
    const rho = mass / V;
    const tr = Sc[0] + Sc[1] + Sc[2];
    J = [
      [rho * (tr - Sc[0]), -rho * Sc[3], -rho * Sc[4]],
      [-rho * Sc[3], rho * (tr - Sc[1]), -rho * Sc[5]],
      [-rho * Sc[4], -rho * Sc[5], rho * (tr - Sc[2])],
    ];
    center = new THREE.Vector3(g[0], g[1], g[2]).add(ref);
    solid = box.containsPoint(center);
  }
  if (!solid) {
    const k = mass / 12;
    J = [[k * (size.y ** 2 + size.z ** 2), 0, 0], [0, k * (size.x ** 2 + size.z ** 2), 0], [0, 0, k * (size.x ** 2 + size.y ** 2)]];
    center = box.getCenter(new THREE.Vector3());
  }
  const { values: I, vectors: E } = eigenSym3(J);
  const radii = [0, 1, 2].map((i) => Math.sqrt(Math.max((5 / (2 * mass)) * (I[(i + 1) % 3] + I[(i + 2) % 3] - I[i]), 1e-10)));
  const basis = new THREE.Matrix4().set(
    E[0][0], E[0][1], E[0][2], 0,
    E[1][0], E[1][1], E[1][2], 0,
    E[2][0], E[2][1], E[2][2], 0,
    0, 0, 0, 1,
  );
  if (basis.determinant() < 0) basis.scale(new THREE.Vector3(1, 1, -1));
  return { center, radii: new THREE.Vector3(...radii), quaternion: new THREE.Quaternion().setFromRotationMatrix(basis), fromVolume: solid };
}

function centerlinePoints(flat) {
  const pts = [];
  for (let i = 0; i + 2 < flat.length; i += 3) pts.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
  return pts;
}

/* Persistent isolated preview (one WebGL context, contents swapped per selection). */
function createPhysPreview(container) {
  const scene = new THREE.Scene();
  addGalleryLights(scene);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.prepend(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = !REDUCED_MOTION;
  controls.autoRotateSpeed = 1.2;
  const resize = () => fitRenderer(renderer, camera, container);
  new ResizeObserver(resize).observe(container);
  resize();
  visibleLoop(container, () => {
    controls.update();
    renderer.render(scene, camera);
  });

  let group = null;
  let owned = []; // geometries and materials created here (shared mesh geometry is never disposed)
  let visualMats = [];
  const layers = {};

  const own = (x) => {
    owned.push(x);
    return x;
  };
  const clear = () => {
    if (group) scene.remove(group);
    owned.forEach((x) => x.dispose());
    owned = [];
    visualMats = [];
    group = null;
    Object.keys(layers).forEach((k) => delete layers[k]);
  };
  const place = (target, src) => {
    src.updateWorldMatrix(true, false);
    target.matrix.copy(src.matrixWorld);
    target.matrix.decompose(target.position, target.quaternion, target.scale);
    return target;
  };

  return {
    /* meshes: world-space source meshes; overlays: { inertia: () => spec, sim: [{ kind, points?, meshes? }] } */
    show(meshes, overlays) {
      clear();
      group = new THREE.Group();
      const visual = new THREE.Group();
      meshes.forEach((m) => {
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => own(x.clone()));
        visualMats.push(...mats);
        visual.add(place(new THREE.Mesh(m.geometry, Array.isArray(m.material) ? mats : mats[0]), m));
      });
      group.add(visual);
      scene.add(group);
      const center = new THREE.Box3().setFromObject(visual).getCenter(new THREE.Vector3());
      group.position.copy(center).negate();
      group.updateMatrixWorld(true);
      frameObject(camera, group, controls, 1.45);
      layers.inertia = overlays.inertia;
      layers.sim = overlays.sim;
    },
    setOverlay(name, on) {
      if (!group) return;
      const key = `${name}Group`;
      if (on && !layers[key]) {
        const g = new THREE.Group();
        if (name === "inertia" && layers.inertia) {
          const e = layers.inertia();
          const ellipsoid = new THREE.Mesh(
            own(new THREE.SphereGeometry(1, 48, 24)),
            own(new THREE.MeshBasicMaterial({ color: "#ef6a3a", transparent: true, opacity: 0.28, depthWrite: false })),
          );
          const wire = new THREE.Mesh(ellipsoid.geometry, own(new THREE.MeshBasicMaterial({ color: "#c2410c", wireframe: true, transparent: true, opacity: 0.35 })));
          [ellipsoid, wire].forEach((x) => {
            x.position.copy(e.center);
            x.quaternion.copy(e.quaternion);
            x.scale.copy(e.radii);
            x.renderOrder = 3;
            g.add(x);
          });
          const dot = new THREE.Mesh(own(new THREE.SphereGeometry(1, 16, 8)), own(new THREE.MeshBasicMaterial({ color: "#1a1d24", depthTest: false })));
          dot.position.copy(e.center);
          dot.scale.setScalar(Math.max(e.radii.x, e.radii.y, e.radii.z) * 0.04);
          dot.renderOrder = 4;
          g.add(dot);
        }
        if (name === "sim") {
          (layers.sim || []).forEach((s) => {
            const color = SIM_COLOR[s.kind];
            if (s.proxy) { // world-space proxy mesh from 67d_sim_geometry.json
              const geo = own(new THREE.BufferGeometry());
              geo.setAttribute("position", new THREE.Float32BufferAttribute(s.proxy.positions, 3));
              geo.setIndex(s.proxy.triangles);
              const wire = new THREE.Mesh(geo, own(new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false })));
              wire.renderOrder = 3;
              g.add(wire);
            }
            if (s.points) {
              const geo = own(new THREE.BufferGeometry().setFromPoints(s.points));
              const line = new THREE.Line(geo, own(new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })));
              line.renderOrder = 4;
              g.add(line);
              if (s.points.length <= 400) { // vertex dots only where they stay distinguishable
                const verts = new THREE.Points(geo, own(new THREE.PointsMaterial({ color, size: 3.5, sizeAttenuation: false, depthTest: false, transparent: true })));
                verts.renderOrder = 4;
                g.add(verts);
              }
            }
            (s.meshes || []).forEach((m) => {
              const wire = new THREE.Mesh(m.geometry, own(new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45, depthWrite: false })));
              wire.renderOrder = 3;
              g.add(place(wire, m));
            });
          });
        }
        layers[key] = g;
        group.add(g);
      }
      if (layers[key]) layers[key].visible = on;
      if (name === "sim") {
        visualMats.forEach((m) => {
          if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
          const base = m.userData.baseOpacity;
          m.transparent = on || base.transparent;
          m.opacity = on ? Math.min(base.opacity, 0.22) : base.opacity;
          m.depthWrite = on ? false : base.depthWrite;
          m.needsUpdate = true;
        });
      }
    },
  };
}

function initPhysicsInspector() {
  const container = document.getElementById("phys-canvas");
  const loaderEl = document.getElementById("phys-loader");
  if (!container || !loaderEl) return;
  const ui = loaderUI(loaderEl);
  const hoverEl = document.getElementById("phys-hover");
  const nameEl = document.getElementById("phys-name");
  const tagsEl = document.getElementById("phys-tags");
  const factsEl = document.getElementById("phys-facts");
  const sectionsEl = document.getElementById("phys-sections");
  const previewEl = document.getElementById("phys-preview");
  const noteEl = document.getElementById("phys-overlay-note");
  const overlayBtns = [...previewEl.querySelectorAll("[data-overlay]")];
  const fullBtn = previewEl.querySelector("[data-fullscreen]");
  const chips = [...document.querySelectorAll("#phys-filter [data-filter]")];
  const overviewBtn = document.getElementById("phys-overview");

  if (!hasWebGL()) {
    ui.error("WebGL is not available in this browser", "The interactive scene needs WebGL.");
    return;
  }

  const VIEW = { position: new THREE.Vector3(4.25, 3.05, -5.35), target: new THREE.Vector3(0, 1.15, 0.25) };
  const CUTAWAY = ["ceiling", "wall_window", "wall_right", "radiator"];
  const PRESELECT = "phone_right"; // the paper's telephone-cord example

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dfe2da");
  const camera = new THREE.PerspectiveCamera(47, 1, 0.03, 80);
  camera.position.copy(VIEW.position);
  const renderer = makeRenderer(container);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.copy(VIEW.target);
  controls.minDistance = 0.4;
  controls.maxDistance = 11;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();
  scene.add(new THREE.HemisphereLight("#fff5df", "#526157", 2.1));
  const key = new THREE.DirectionalLight("#fff3d5", 3.2);
  key.position.set(-3, 7, -4);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#cbe0ff", 1.4);
  fill.position.set(5, 3, 5);
  scene.add(fill);
  const resize = () => fitRenderer(renderer, camera, container);
  new ResizeObserver(resize).observe(container);
  resize();

  const fly = { active: false, position: VIEW.position.clone(), target: VIEW.target.clone() };
  controls.addEventListener("start", () => { fly.active = false; });
  overviewBtn.addEventListener("click", () => {
    fly.active = true;
    fly.position.copy(VIEW.position);
    fly.target.copy(VIEW.target);
  });

  // ---- state
  let objects = null;
  let simGeo = null; // { curves: {name: {role, points}}, meshes: {name: {role, positions, triangles}} }
  const objMeshes = new Map(); // object key -> meshes
  const compMeshes = new Map(); // component -> meshes
  const meshInfo = new Map(); // mesh -> { key, comp }
  let pickables = [];
  let selected = null;
  const inertiaCache = new Map();
  const preview = createPhysPreview(previewEl);

  // ---- tint overlays in the main scene
  const tint = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const selectMat = tint("#ff5a36", 0.5);
  const hoverMat = tint("#ffffff", 0.32);
  const filterMats = Object.fromEntries(Object.entries(PHYS_COLOR).map(([k, c]) => [k, tint(c, 0.55)]));
  const overlays = { select: [], hover: [], filter: [] };
  // screen-space ring on the selected object, so small objects stay findable in the overview
  const ringTexture = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.strokeStyle = "#ff5a36";
    g.lineWidth = 10;
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture, depthTest: false, transparent: true, sizeAttenuation: false }));
  ring.renderOrder = 10;
  ring.visible = false;
  scene.add(ring);
  const addTint = (meshes, mat, bucket) => meshes.forEach((m) => {
    const o = new THREE.Mesh(m.geometry, mat);
    o.raycast = () => {};
    o.renderOrder = 2;
    m.add(o);
    bucket.push(o);
  });
  const clearTint = (bucket) => {
    bucket.forEach((o) => o.removeFromParent());
    bucket.length = 0;
  };

  // ---- panel
  const typeTag = (type, suffix = "") => el("span", `tag ${PHYS_TYPE[type].tag}`, PHYS_TYPE[type].label + suffix);

  const render = (k, hitComp) => {
    const o = objects[k];
    nameEl.textContent = o.label;
    tagsEl.replaceChildren(typeTag(o.type));
    const compTypes = [...new Set((o.components || []).map((c) => c.type))];
    compTypes.forEach((t) => tagsEl.append(typeTag(t, " part")));

    const facts = [];
    if (o.type === "static") facts.push(["Mobility", "Fixed to the world"]);
    if (o.mass != null) facts.push(["Mass", fmt.mass(o.mass), o.mass_note]);
    else if (o.derived_mass != null) facts.push(["Mass", `≈ ${fmt.mass(o.derived_mass)}`, "ρ × geometry"]);
    if (o.friction != null) facts.push(["Friction μ", sig(o.friction)]);
    if (o.contact_distance != null) facts.push(["Contact distance δ", fmt.mm(o.contact_distance)]);
    if (o.fixed_base) facts.push(["Base", "Fixed to the world"]);
    if (o.fixed) facts.push(["Mobility", "Fixed in place"]);
    if (o.inside && objects[o.inside]) facts.push(["Placed inside", objects[o.inside].label]);
    if (o.pinned === false) facts.push(["Constraints", "None, held by contact only"]);
    if (o.joints) facts.push(["Joints", String(jointCount(o))]);
    if (o.rest) facts.push(["Rest state", o.rest]);
    fillRows(factsEl, facts);

    const secs = [];
    if (o.material) {
      const s = el("section");
      s.append(el("h4", "", o.type === "rigid" ? "Body model" : "Constitutive model"), fillRows(el("dl", "phys-rows"), materialRows(o.material)));
      secs.push(s);
    }
    if (o.gas) {
      const s = el("section");
      s.append(el("h4", "", "Enclosed gas"), fillRows(el("dl", "phys-rows"), gasRows(o.gas)));
      secs.push(s);
    }
    if (o.joints) {
      const s = el("section");
      s.append(el("h4", "", `Joints · ${jointCount(o)}`));
      const table = el("table", "phys-joints");
      const tbody = el("tbody");
      o.joints.forEach((j) => {
        const tr = el("tr");
        const name = el("td", "", j.name);
        if (j.count) name.append(el("small", "", `${j.count} joints`));
        const range = el("td", "", fmtJointRange(j));
        if (j.mimic) range.append(el("small", "", `follows ${j.mimic}${j.mimic_multiplier === -1 ? " (mirrored)" : ""}`));
        tr.append(name, el("td", "", JOINT_TYPE[j.type] || j.type), range);
        tbody.append(tr);
      });
      table.append(tbody);
      s.append(table);
      secs.push(s);
    }
    if (o.components) {
      const s = el("section");
      s.append(el("h4", "", "Deformable parts"));
      o.components.forEach((c) => {
        const card = el("div", `phys-comp${c === hitComp ? " is-hit" : ""}`);
        const head = el("div", "phys-comp-head");
        head.append(el("strong", "", prettyPart(c.part)), typeTag(c.type));
        const rows = materialRows(c.material);
        if (c.friction != null) rows.push(["Friction μ", sig(c.friction)]);
        if (c.contact_distance != null) rows.push(["Contact distance δ", fmt.mm(c.contact_distance)]);
        if (c.derived_mass != null) rows.push(["Mass", `≈ ${fmt.mass(c.derived_mass)}`, "ρ × geometry"]);
        if (c.rest) rows.push(["Rest state", c.rest]);
        card.append(head, fillRows(el("dl", "phys-rows"), rows));
        s.append(card);
      });
      secs.push(s);
    }
    sectionsEl.replaceChildren(...secs);
  };

  // ---- preview overlays
  // What the simulator uses: explicit QIPC proxies (rod spans, foam volumes, ABD collision meshes) when the
  // blend provides them, otherwise the display centerline or the visual mesh itself.
  const simParts = (k) => {
    const o = objects[k];
    const parts = [];
    const add = (holder, meshes) => {
      if (holder.sim_geometry) {
        holder.sim_geometry.forEach((name) => {
          const c = simGeo.curves[name];
          const m = simGeo.meshes[name];
          if (c) parts.push({ kind: "curve", role: c.role, points: centerlinePoints(c.points) });
          else if (m) parts.push({ kind: m.role === "collision" ? "collision" : holder.type, role: m.role, proxy: m });
        });
      } else if (holder.type === "curve" && simGeo.curves[holder.centerline]) {
        parts.push({ kind: "curve", role: "display", points: centerlinePoints(simGeo.curves[holder.centerline].points) });
      } else if (holder.type === "surface" || holder.type === "volume") {
        parts.push({ kind: holder.type, role: "visual", meshes });
      }
    };
    add(o, objMeshes.get(k));
    (o.components || []).forEach((c) => add(c, compMeshes.get(c) || []));
    return parts;
  };
  const simNote = (k) => {
    const parts = simParts(k);
    const bits = [];
    const plural = (noun) => (noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`);
    const count = (list, noun) => (list.length > 1 ? `${list.length} ${plural(noun)}` : noun[0].toUpperCase() + noun.slice(1));
    const tris = (p) => (p.proxy ? p.proxy.triangles.length / 3
      : p.meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0));
    [["rod", "simulated rod"], ["display", "rod centerline"]].forEach(([role, noun]) => {
      const list = parts.filter((p) => p.role === role);
      if (list.length) bits.push(`${count(list, noun)} · ${list.reduce((n, p) => n + p.points.length, 0).toLocaleString()} vertices`);
    });
    [["volume_proxy", "volume proxy"], ["collision", "collision proxy"]].forEach(([role, noun]) => {
      const list = parts.filter((p) => p.role === role);
      if (list.length) bits.push(`${count(list, noun)} · ${Math.round(list.reduce((n, p) => n + tris(p), 0)).toLocaleString()} triangles`);
    });
    parts.filter((p) => p.role === "visual" && p.kind === "surface").forEach((p) => bits.push(`Shell mesh · ${Math.round(tris(p)).toLocaleString()} triangles`));
    if (parts.some((p) => p.role === "visual" && p.kind === "volume")) bits.push("Watertight solid for tetrahedral meshing");
    return bits.join(" · ");
  };
  const overlayState = { inertia: false, sim: false };
  const syncOverlayNote = () => {
    const notes = [];
    if (overlayState.inertia) notes.push("Inertia ellipsoid: same mass and principal moments, uniform density.");
    if (overlayState.sim && selected) notes.push(simNote(selected.key));
    noteEl.textContent = notes.join(" ");
    noteEl.hidden = !notes.length;
  };
  overlayBtns.forEach((btn) => btn.addEventListener("click", () => {
    const name = btn.dataset.overlay;
    overlayState[name] = !overlayState[name];
    btn.setAttribute("aria-pressed", String(overlayState[name]));
    preview.setOverlay(name, overlayState[name]);
    syncOverlayNote();
  }));
  if (!previewEl.requestFullscreen) fullBtn.hidden = true;
  fullBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else previewEl.requestFullscreen();
  });

  const select = (k, hitComp = null) => {
    const o = objects[k];
    selected = { key: k, comp: hitComp };
    clearTint(overlays.select);
    addTint(objMeshes.get(k), selectMat, overlays.select);
    const box = new THREE.Box3();
    objMeshes.get(k).forEach((m) => box.expandByObject(m, false));
    box.getCenter(ring.position);
    ring.visible = true;
    render(k, hitComp);
    const hasMass = (o.type === "rigid" || o.type === "articulated") && o.mass != null;
    const sim = simParts(k);
    preview.show(objMeshes.get(k), {
      inertia: hasMass ? () => {
        if (!inertiaCache.has(k)) inertiaCache.set(k, inertiaEllipsoid(objMeshes.get(k), o.mass));
        return inertiaCache.get(k);
      } : null,
      sim,
    });
    const avail = { inertia: hasMass, sim: sim.length > 0 };
    overlayBtns.forEach((btn) => {
      const name = btn.dataset.overlay;
      btn.hidden = !avail[name];
      if (!avail[name]) overlayState[name] = false;
      btn.setAttribute("aria-pressed", String(overlayState[name]));
      if (overlayState[name]) preview.setOverlay(name, true);
    });
    syncOverlayNote();
  };

  // ---- category highlight chips
  const activeFilters = new Set();
  const refreshFilters = () => {
    clearTint(overlays.filter);
    activeFilters.forEach((t) => {
      Object.entries(objects).forEach(([k, o]) => {
        if (o.type === t) addTint(objMeshes.get(k) || [], filterMats[t], overlays.filter);
        (o.components || []).forEach((c) => { if (c.type === t) addTint(compMeshes.get(c) || [], filterMats[t], overlays.filter); });
      });
    });
  };
  chips.forEach((chip) => chip.addEventListener("click", () => {
    const t = chip.dataset.filter;
    if (activeFilters.has(t)) activeFilters.delete(t);
    else activeFilters.add(t);
    chip.setAttribute("aria-pressed", String(activeFilters.has(t)));
    refreshFilters();
  }));

  // ---- picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = { x: 0, y: 0 };
  let hoverRaf = 0;
  let hoverKey = null;
  const pick = (x, y) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((x - r.left) / r.width) * 2 - 1;
    ndc.y = -((y - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    return hit ? meshInfo.get(hit.object) : null;
  };
  const setHover = (info) => {
    const k = info ? info.key : null;
    const label = info ? `${objects[k].label}${info.comp ? ` › ${prettyPart(info.comp.part)}` : ""} · ${PHYS_TYPE[info.comp ? info.comp.type : objects[k].type].label}` : "";
    hoverEl.textContent = label;
    hoverEl.classList.toggle("is-visible", !!label);
    renderer.domElement.style.cursor = k ? "pointer" : "grab";
    if (k === hoverKey) return;
    hoverKey = k;
    clearTint(overlays.hover);
    if (k && (!selected || selected.key !== k)) addTint(objMeshes.get(k), hoverMat, overlays.hover);
  };
  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!objects || e.buttons !== 0 || hoverRaf) return;
    const { clientX, clientY } = e;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      setHover(pick(clientX, clientY));
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => setHover(null));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!objects || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const info = pick(e.clientX, e.clientY);
    if (!info) return;
    clearTint(overlays.hover);
    hoverKey = null;
    select(info.key, info.comp);
  });

  visibleLoop(container, (t) => {
    if (fly.active) {
      camera.position.lerp(fly.position, 0.11);
      controls.target.lerp(fly.target, 0.11);
      if (camera.position.distanceTo(fly.position) < 0.015 && controls.target.distanceTo(fly.target) < 0.015) fly.active = false;
    }
    if (ring.visible) ring.scale.setScalar(0.07 * (REDUCED_MOTION ? 1 : 1 + Math.sin(t * 0.005) * 0.12));
    controls.update();
    renderer.render(scene, camera);
  });

  // ---- build the object index once the scene and its physics description are loaded
  const setup = (gltf, phys, geometry) => {
    objects = phys.objects;
    simGeo = geometry;
    const root = gltf.scene;
    const defs = gltf.parser.json.nodes;
    // three.js strips "." from node names; keep the original glTF names for matching the JSON
    root.traverse((n) => {
      const a = gltf.parser.associations.get(n);
      if (a && a.nodes !== undefined) n.userData.gltfName = defs[a.nodes].name;
      if (CUTAWAY.includes(n.userData.gltfName)) n.visible = false;
    });
    const byName = new Map();
    root.traverse((n) => { if (n.userData.gltfName) byName.set(n.userData.gltfName, n); });

    const explicit = new Map(); // glTF node name -> object key
    const compByNode = new Map(); // glTF node name -> component
    Object.entries(objects).forEach(([k, o]) => {
      (o.nodes || []).forEach((n) => explicit.set(n, k));
      (o.components || []).forEach((c) => (c.nodes || []).forEach((n) => compByNode.set(n, c)));
    });

    // A curve component exported without geometry (the left phone cord) is rebuilt from its centerline,
    // using the material of a sibling component with the same part name.
    root.updateMatrixWorld(true);
    const partMaterial = new Map();
    compByNode.forEach((c, n) => {
      const node = byName.get(n);
      node?.traverse((m) => { if (m.isMesh && !partMaterial.has(c.part)) partMaterial.set(c.part, m.material); });
    });
    compByNode.forEach((c, n) => {
      const node = byName.get(n);
      const line = simGeo.curves[c.centerline];
      if (!node || c.type !== "curve" || !line) return;
      let hasMesh = false;
      node.traverse((m) => { if (m.isMesh) hasMesh = true; });
      if (hasMesh) return;
      const path = new THREE.CatmullRomCurve3(centerlinePoints(line.points), false, "centripetal");
      path.arcLengthDivisions = line.points.length;
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(path, line.points.length / 3, c.material.radius, 8, false),
        partMaterial.get(c.part) || new THREE.MeshStandardMaterial({ color: "#2b2d31", roughness: 0.6 }),
      );
      tube.applyMatrix4(node.matrixWorld.clone().invert());
      node.add(tube);
    });

    const ownerOf = (m) => {
      for (let n = m; n && n !== root; n = n.parent) {
        const name = n.userData.gltfName;
        if (!name) continue;
        if (explicit.has(name)) return explicit.get(name);
        const art = /^ART\.part\.([^.]+)\./.exec(name);
        if (art && objects[art[1]]) return art[1];
        if (objects[name]) return name;
      }
      return null;
    };
    const compOf = (m, k) => {
      for (let n = m; n && n !== root; n = n.parent) {
        const c = compByNode.get(n.userData.gltfName);
        if (c && (objects[k].components || []).includes(c)) return c;
      }
      return null;
    };
    root.updateMatrixWorld(true);
    root.traverse((m) => {
      if (!m.isMesh) return;
      const k = ownerOf(m);
      if (!k) return;
      const comp = compOf(m, k);
      meshInfo.set(m, { key: k, comp });
      if (!objMeshes.has(k)) objMeshes.set(k, []);
      objMeshes.get(k).push(m);
      if (comp) {
        if (!compMeshes.has(comp)) compMeshes.set(comp, []);
        compMeshes.get(comp).push(m);
      }
      if (isShown(m)) pickables.push(m);
    });
    scene.add(root);

    const counts = { articulated: 0, curve: 0, surface: 0, volume: 0 };
    Object.values(objects).forEach((o) => {
      if (o.type in counts) counts[o.type] += 1;
      (o.components || []).forEach((c) => { if (c.type in counts) counts[c.type] += 1; });
    });
    chips.forEach((chip) => {
      chip.querySelector("small").textContent = counts[chip.dataset.filter];
      chip.disabled = false;
    });
    const linked = new URLSearchParams(window.location.search).get("object"); // e.g. ?object=bag_bin_rear_01#physics
    select(objects[linked] ? linked : objects[PRESELECT] ? PRESELECT : Object.keys(objects)[0]);
    ui.done();
  };

  const load = () => {
    ui.progress(2, "Loading the reconstructed office", "Fetching geometry and physical properties…");
    const json = (url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
    const glb = new Promise((resolve, reject) => makeLoader().load("scene.glb", resolve, (xhr) => {
      if (xhr.total > 0) {
        const pct = Math.min(96, Math.round((xhr.loaded / xhr.total) * 96));
        ui.progress(pct, "Loading the reconstructed office", `${formatMB(xhr.loaded)} of ${formatMB(xhr.total)}${pct >= 96 ? " · decoding meshes…" : ""}`);
      }
    }, reject));
    Promise.all([glb, json("physics/67d.json"), json("physics/67d_sim_geometry.json")])
      .then(([gltf, phys, geometry]) => setup(gltf, phys, geometry))
      .catch((err) => {
        console.error("Failed to load the physics inspector", err);
        ui.error("The scene failed to load", "Please refresh the page.");
      });
  };
  whenNear(container, load);
}

/* ---------------------------------------------------------------- boot */
// Articulated office viewer temporarily hidden (its section in index.html is commented out).
// try {
//   initArticulatedScene();
// } catch (err) {
//   console.error(err);
// }
// Scene gallery temporarily hidden (its section in index.html is commented out).
// try {
//   initSceneGallery();
// } catch (err) {
//   console.error(err);
// }
try {
  initPhysicsInspector();
} catch (err) {
  console.error(err);
}
