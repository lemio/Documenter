/*
 * MicroPython Visual
 * ------------------
 * A freeform board of "value blocks". Each block can be bound to a pin on an
 * ESP32 running MicroPython; the running Python program is regenerated and
 * re-sent whenever a binding changes, and telemetry from the device drives
 * the block values and sparklines.
 *
 * Visual reference: FigmaExport/*.svg (white rounded pills, gray text, a blue
 * sparkline dot, a translucent title marker on a black canvas). This app no
 * longer loads those SVGs — it just follows the look.
 */

import { Device, generateProgram } from "./device.js";

// ---- pins offered in the picker (ESP32-S3) -----------------------------
const DIGITAL_PINS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 35, 36, 37, 38, 39, 40, 41, 42, 47, 48];
const ANALOG_PINS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // ADC1 — reliable
const ADC_MAX = 4095;
const SPARK_LEN = 48;

// ESP32-S3 ADC attenuation → measurable input range (mV). 11 dB is default.
const ATTEN = [
  { key: "0", mv: 950 },
  { key: "2_5", mv: 1250 },
  { key: "6", mv: 1750 },
  { key: "11", mv: 3100 },
];
const DEFAULT_ATTEN = "11";
const attenMv = (b) => (ATTEN.find((a) => a.key === (b.atten || DEFAULT_ATTEN)) || ATTEN[3]).mv;

const PWM_FREQS = [100, 500, 1000, 5000, 25000];
const fmtFreq = (f) => (f >= 1000 ? f / 1000 + "kHz" : f + "Hz");
const fmtFreqLong = (f) => (f >= 1000 ? f / 1000 + " kHz" : f + " Hz");
const VSUPPLY = 3.3; // GPIO rail — used for PWM average-voltage display

// ---- state -----------------------------------------------------------
const STORE_KEY = "mpv.board.v1";

let uid = 1;

const BLANK = "_"; // hover-only placeholder for an empty label / icon / title

const state = load() || {
  title: "Sensor board",
  demo: false,
  webcam: false,
  blocks: [
    block({ x: 30, y: 110, label: "button", icon: "🔘", pin: 4, mode: "in" }),
    block({ x: 30, y: 250, label: "light sensor", icon: "🔆", pin: 5, mode: "analog", display: "raw", sparkline: true }),
  ],
};

uid = Math.max(uid, ...state.blocks.map((b) => (+b.id || 0) + 1));

function block(overrides = {}) {
  return {
    id: String(uid++),
    x: 30,
    y: 110,
    label: "",
    icon: "",
    pin: null,
    mode: "in", // in | analog | out | pwm | uart
    pull: "none", // none | up | down   (digital input)
    atten: DEFAULT_ATTEN, // "0" | "2_5" | "6" | "11"   (analog input)
    display: "raw", // raw | voltage | percent   (analog only)
    sparkline: false,
    autoScale: false,
    invert: false,
    outValue: 0,
    pwmFreq: 1000, // Hz   (pwm output)
    pwmDuty: 50, // percent   (pwm output)
    uartMatch: "", // string to look for on a serial line   (uart)
    ...overrides,
    value: null,
    hist: [],
  };
}

// The whole state lives in localStorage — blocks (incl. live values and
// sparkline history), title, and the demo / webcam toggles. Writes are
// debounced, with a periodic flush so streaming values survive a reload.
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(saveNow, 200);
}
function saveNow() {
  clearTimeout(saveT);
  saveT = null;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}
setInterval(saveNow, 4000);
addEventListener("beforeunload", saveNow);
addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
function load() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!p || !Array.isArray(p.blocks)) return null;
    p.title = p.title === BLANK ? "" : p.title || "";
    p.demo = !!p.demo;
    p.webcam = !!p.webcam;
    for (const b of p.blocks) {
      b.label = b.label === BLANK ? "" : b.label || "";
      b.icon = b.icon === BLANK ? "" : b.icon || "";
      b.pull = b.pull || "none";
      b.atten = ATTEN.some((a) => a.key === b.atten) ? b.atten : DEFAULT_ATTEN;
      b.pwmFreq = +b.pwmFreq > 0 ? +b.pwmFreq : 1000;
      b.pwmDuty = b.pwmDuty >= 0 && b.pwmDuty <= 100 ? +b.pwmDuty : 50;
      b.uartMatch = typeof b.uartMatch === "string" ? b.uartMatch : "";
      b.autoScale = !!b.autoScale;
      b.value = b.value ?? null;
      b.hist = Array.isArray(b.hist) ? b.hist : [];
    }
    return p;
  } catch (e) {
    return null;
  }
}

// ---- elements ------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const blocksEl = $("#blocks");
const titleEl = $("#title");
const layer = $("#layer");
const addBtn = $("#add");
const deviceBtn = $("#device");
const progressEl = $("#progress");
const toastEl = $("#toast");

const nodes = new Map(); // block id -> { wrap, value, spark }

// ---- device -----------------------------------------------------
const device = new Device();
let syncTimer = null;

device.onStatus = (s) => {
  deviceBtn.classList.toggle("is-connecting", s === "connecting" || s === "checking");
  deviceBtn.classList.toggle("is-flashing", s === "flashing");
  deviceBtn.classList.toggle("is-running", s === "running");
  deviceBtn.classList.toggle("is-error", s === "error");
  const label = {
    disconnected: state.demo ? "demo" : "connect",
    connecting: "connecting…",
    checking: "checking…",
    connected: "ready",
    flashing: "flashing…",
    running: "live",
    error: "error",
  }[s] || s;
  $(".lbl", deviceBtn).textContent = label;
};
device.onData = (map) => {
  for (const b of state.blocks) {
    if (b.pin == null) continue;
    const key = String(b.pin);
    if (!(key in map)) continue;
    setValue(b, map[key]);
  }
  renderValues();
};

// UART mode: every non-telemetry serial line is scanned for each block's
// match string; the first number after it (or on the line) becomes the value.
const NUMBER_RE = /-?\d+(?:\.\d+)?/;
device.onLine = (line) => {
  let hit = false;
  for (const b of state.blocks) {
    if (b.mode !== "uart" || !b.uartMatch) continue;
    const at = line.indexOf(b.uartMatch);
    if (at < 0) continue;
    const m = line.slice(at + b.uartMatch.length).match(NUMBER_RE) || line.match(NUMBER_RE);
    if (m) { setValue(b, parseFloat(m[0])); hit = true; }
  }
  if (hit) renderValues();
};
device.onLog = (l) => console.debug("[device]", l);

function setValue(b, v) {
  b.value = v;
  if (b.sparkline && v != null && (b.mode === "analog" || b.mode === "in" || b.mode === "uart")) {
    b.hist.push(Number(v));
    if (b.hist.length > SPARK_LEN) b.hist.shift();
  }
}

// ---- rendering -------------------------------------------------
function render() {
  titleEl.textContent = state.title;
  blocksEl.textContent = "";
  nodes.clear();
  for (const b of state.blocks) blocksEl.appendChild(renderBlock(b));
  renderValues();
}

function renderBlock(b) {
  const wrap = el("div", "block-wrap");
  wrap.style.left = b.x + "px";
  wrap.style.top = b.y + "px";
  wrap.dataset.id = b.id;

  const pill = el("div", "block");

  const close = el("button", "block-close");
  close.textContent = "×";
  close.title = "Remove block";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    removeBlock(b.id);
  });

  const label = el("div", "block-label");
  label.contentEditable = "true";
  label.spellcheck = false;
  label.textContent = b.label;
  bindEditable(label, (text) => { b.label = text; save(); });

  const pin = el("button", "block-pin");
  paintPin(pin, b);
  pin.addEventListener("click", (e) => { e.stopPropagation(); openPinMenu(b, pin); });

  const main = el("div", "block-main");

  const spark = elNS("svg", "block-spark");
  spark.setAttribute("preserveAspectRatio", "none");
  spark.innerHTML = '<path></path><circle r="2"></circle>';

  const value = el("span", "block-value");
  value.addEventListener("click", (e) => { e.stopPropagation(); openValueMenu(b, value); });

  const icon = el("span", "block-icon");
  icon.contentEditable = "true";
  icon.textContent = b.icon;
  bindEditable(icon, (text) => { b.icon = text; save(); });

  // to the LEFT of the value: a duty slider for PWM, else the sparkline
  if (b.mode === "pwm") {
    const duty = el("input", "block-pwm");
    duty.type = "range";
    duty.min = "0";
    duty.max = "100";
    duty.step = "1";
    duty.value = String(b.pwmDuty);
    duty.title = "Duty cycle";
    duty.addEventListener("input", () => { b.pwmDuty = +duty.value; renderValues(); });
    duty.addEventListener("change", () => { save(); scheduleSync(); });
    duty.addEventListener("pointerdown", (e) => e.stopPropagation());
    main.append(duty);
  } else if (b.sparkline) {
    main.append(spark);
  }
  main.append(value, icon);

  pill.append(close, label, pin, main);
  wrap.appendChild(pill);

  nodes.set(b.id, { wrap, value, spark });
  makeDraggable(wrap, pill, b);
  armLongPress(wrap);
  return wrap;
}

function renderValues() {
  for (const b of state.blocks) {
    const n = nodes.get(b.id);
    if (!n) continue;
    const { text, unit, dim } = formatValue(b);
    n.value.innerHTML = text + (unit ? `<span class="unit">${unit}</span>` : "");
    n.value.classList.toggle("dim", dim);
    if (b.sparkline) drawSpark(b, n.spark);
  }
}

function formatValue(b) {
  if (b.mode === "uart") {
    if (!b.uartMatch) return { text: "—", unit: "", dim: true };
    if (b.value == null) return { text: "…", unit: "", dim: true };
    return { text: String(b.value), unit: "", dim: false };
  }
  if (b.pin == null) return { text: "—", unit: "", dim: true };
  if (b.mode === "pwm") {
    if (b.display === "vavg") return { text: ((b.pwmDuty / 100) * VSUPPLY).toFixed(2), unit: "V", dim: false };
    return { text: String(b.pwmDuty), unit: "%", dim: false };
  }
  const v = b.value;
  if (v == null) return { text: "—", unit: "", dim: true };
  if (b.mode === "analog") {
    const maxed = v >= ADC_MAX; // reading saturated — true input may be higher
    if (b.display === "voltage") {
      const vmax = attenMv(b) / 1000;
      const volts = maxed ? vmax : (v / ADC_MAX) * vmax;
      return { text: (maxed ? ">" : "") + volts.toFixed(3), unit: "V", dim: false };
    }
    if (b.display === "percent") {
      return { text: (maxed ? ">100" : String(Math.round((v / ADC_MAX) * 100))), unit: "%", dim: false };
    }
    return { text: String(v), unit: "", dim: false };
  }
  const on = b.invert ? !v : !!v;
  return { text: on ? "HIGH" : "LOW", unit: "", dim: false };
}

function drawSpark(b, svg) {
  const w = svg.clientWidth || 180;
  const h = svg.clientHeight || 26;
  const path = svg.querySelector("path");
  const dot = svg.querySelector("circle");
  const hist = b.hist;
  if (hist.length < 2) {
    path.setAttribute("d", "");
    dot.style.display = "none";
    return;
  }
  dot.style.display = "";
  let lo, hi;
  if (b.autoScale || b.mode === "uart") {
    // UART values have no known range, so always fit to the data
    lo = Math.min(...hist);
    hi = Math.max(...hist);
  } else if (b.mode === "analog") {
    lo = 0;
    hi = ADC_MAX;
  } else {
    lo = 0;
    hi = 1;
  }
  const span = hi - lo || 1;
  const pad = 3;
  const pts = hist.map((v, i) => {
    const x = (i / (hist.length - 1)) * w;
    const y = h - pad - ((v - lo) / span) * (h - 2 * pad);
    return [x, y];
  });
  path.setAttribute("d", pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)).join(" "));
  const last = pts[pts.length - 1];
  dot.setAttribute("cx", last[0].toFixed(1));
  dot.setAttribute("cy", last[1].toFixed(1));
}

function paintPin(btn, b) {
  if (b.mode === "uart") {
    const t = (b.uartMatch || "").trim();
    btn.classList.toggle("unset", !t);
    btn.textContent = t ? `uart “${t.length > 12 ? t.slice(0, 12) + "…" : t}”` : "set uart text";
    return;
  }
  if (b.pin == null) {
    btn.classList.add("unset");
    btn.textContent = "set pin";
  } else {
    btn.classList.remove("unset");
    const tag = { in: "in", analog: "adc", out: "out", pwm: "pwm" }[b.mode];
    let extra = "";
    if (b.mode === "in") extra = { up: " ↑", down: " ↓", none: "" }[b.pull] || "";
    else if (b.mode === "analog") extra = ` ·${attenMv(b) / 1000}V`;
    else if (b.mode === "pwm") extra = ` ·${fmtFreq(b.pwmFreq)}`;
    btn.innerHTML = `${tag}<b>${b.pin}</b>${extra}`;
  }
}

// ---- block lifecycle -----------------------------------------
function addBlock() {
  const n = state.blocks.length;
  const b = block({ x: 30 + (n % 4) * 14, y: 110 + (n % 6) * 16 });
  state.blocks.push(b);
  blocksEl.appendChild(renderBlock(b));
  save();
}

function removeBlock(id) {
  state.blocks = state.blocks.filter((b) => b.id !== id);
  const n = nodes.get(id);
  if (n) n.wrap.remove();
  nodes.delete(id);
  save();
  scheduleSync();
}

// ---- editing helpers --------------------------------------
// An empty field is allowed; CSS shows a faint "_" placeholder only while the
// block is hovered so it stays discoverable and clickable.
function bindEditable(node, commit) {
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); node.blur(); }
  });
  node.addEventListener("input", () => commit(node.textContent.trim()));
  node.addEventListener("blur", () => {
    const text = node.textContent.trim();
    if (node.textContent !== text) node.textContent = text;
    commit(text);
  });
  node.addEventListener("pointerdown", (e) => e.stopPropagation());
}

// ---- drag & drop -----------------------------------------
function makeDraggable(wrap, handle, b) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const t = e.target;
    if (t.closest("button, input, [contenteditable='true'], .block-value")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = b.x;
    const baseY = b.y;
    let dragging = false;
    handle.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      if (!dragging) { dragging = true; wrap.classList.add("dragging"); wrap.classList.remove("armed"); }
      b.x = Math.max(-8, Math.min(window.innerWidth - 60, baseX + dx));
      b.y = Math.max(-8, Math.min(window.innerHeight - 40, baseY + dy));
      wrap.style.left = b.x + "px";
      wrap.style.top = b.y + "px";
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (dragging) { wrap.classList.remove("dragging"); save(); }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// ---- long-press to reveal the close cross on touch -------
function armLongPress(wrap) {
  let timer = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  wrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    timer = setTimeout(() => {
      document.querySelectorAll(".block-wrap.armed").forEach((w) => w.classList.remove("armed"));
      wrap.classList.add("armed");
    }, 500);
  });
  wrap.addEventListener("pointermove", clear);
  wrap.addEventListener("pointerup", clear);
  wrap.addEventListener("pointercancel", clear);
  wrap.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    wrap.classList.toggle("armed");
  });
}
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".block-wrap.armed")) {
    document.querySelectorAll(".block-wrap.armed").forEach((w) => w.classList.remove("armed"));
  }
});

// ---- popovers -----------------------------------------
function openPopover(anchor, buildInner) {
  closePopover();
  const pop = el("div", "popover");
  buildInner(pop);
  layer.appendChild(pop);
  layer.classList.add("open");
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - pr.width - 8);
  let y = r.bottom + 6;
  if (y + pr.height > window.innerHeight - 8) y = Math.max(8, r.top - pr.height - 6);
  pop.style.left = Math.max(8, x) + "px";
  pop.style.top = y + "px";
}
function closePopover() {
  layer.classList.remove("open");
  layer.textContent = "";
}
layer.addEventListener("pointerdown", (e) => { if (e.target === layer) closePopover(); });

function openPinMenu(b, anchor) {
  openPopover(anchor, (pop) => {
    pop.innerHTML = "<h4>Pin mode</h4>";
    const modes = [
      ["in", "Digital input"],
      ["analog", "Analog input"],
      ["out", "Digital output"],
      ["pwm", "PWM output"],
      ["uart", "UART"],
    ];
    for (const [m, name] of modes) {
      const btn = el("button");
      btn.textContent = name;
      btn.setAttribute("aria-checked", String(b.mode === m));
      btn.addEventListener("click", () => {
        b.mode = m;
        if (m === "analog" && !ANALOG_PINS.includes(b.pin)) b.pin = null;
        if (m === "uart") b.pin = null;
        if (m === "out" || m === "pwm") { b.sparkline = false; b.hist = []; }
        commitBinding(b);
        rerenderBlock(b);
        const n = nodes.get(b.id);
        openPinMenu(b, n ? n.wrap.querySelector(".block-pin") : anchor);
      });
      pop.appendChild(btn);
    }

    if (b.mode === "uart") {
      pop.appendChild(el("div", "sep"));
      pop.insertAdjacentHTML("beforeend", "<h4>Text to find on the serial line</h4>");
      const wrapEl = el("div", "text-field");
      const input = el("input");
      input.type = "text";
      input.placeholder = "Distance: ";
      input.value = b.uartMatch || "";
      input.spellcheck = false;
      input.addEventListener("input", () => { b.uartMatch = input.value; commitBinding(b); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") closePopover(); });
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      wrapEl.appendChild(input);
      pop.appendChild(wrapEl);
      pop.insertAdjacentHTML(
        "beforeend",
        '<p class="hint">The first number after this text on a matching line becomes the value. Works with any firmware — no MicroPython needed.</p>'
      );
      setTimeout(() => input.focus(), 0);
      return;
    }

    pop.appendChild(el("div", "sep"));
    pop.insertAdjacentHTML("beforeend", "<h4>GPIO</h4>");
    const grid = el("div", "pins");
    const list = b.mode === "analog" ? ANALOG_PINS : DIGITAL_PINS;
    for (const p of list) {
      const pb = el("button");
      pb.textContent = p;
      if (b.pin === p) pb.classList.add("sel");
      pb.addEventListener("click", () => { b.pin = p; commitBinding(b, anchor, pop); closePopover(); });
      grid.appendChild(pb);
    }
    pop.appendChild(grid);

    if (b.mode === "analog") {
      pop.appendChild(el("div", "sep"));
      pop.insertAdjacentHTML("beforeend", "<h4>Input voltage range</h4>");
      for (const a of ATTEN) {
        const btn = el("button");
        btn.textContent = `0 – ${a.mv} mV` + (a.key === DEFAULT_ATTEN ? "  · default" : "");
        btn.setAttribute("aria-checked", String((b.atten || DEFAULT_ATTEN) === a.key));
        btn.addEventListener("click", () => { b.atten = a.key; commitBinding(b, anchor, pop); openPinMenu(b, anchor); });
        pop.appendChild(btn);
      }
    } else if (b.mode === "in") {
      pop.appendChild(el("div", "sep"));
      pop.insertAdjacentHTML("beforeend", "<h4>Pull resistor</h4>");
      for (const [p, name] of [["none", "None"], ["up", "Pull-up"], ["down", "Pull-down"]]) {
        const btn = el("button");
        btn.textContent = name;
        btn.setAttribute("aria-checked", String((b.pull || "none") === p));
        btn.addEventListener("click", () => { b.pull = p; commitBinding(b, anchor, pop); openPinMenu(b, anchor); });
        pop.appendChild(btn);
      }
    }

    if (b.pin != null) {
      pop.appendChild(el("div", "sep"));
      const clr = el("button");
      clr.textContent = "Unassign pin";
      clr.addEventListener("click", () => { b.pin = null; commitBinding(b, anchor, pop); closePopover(); });
      pop.appendChild(clr);
    }
  });
}

function openValueMenu(b, anchor) {
  const unconfigured = b.mode === "uart" ? !b.uartMatch : b.pin == null;
  if (unconfigured) { openPinMenu(b, anchor.closest(".block").querySelector(".block-pin")); return; }
  openPopover(anchor, (pop) => {
    if (b.mode === "out") {
      pop.innerHTML = "<h4>Output</h4>";
      for (const [v, name] of [[1, "Set HIGH"], [0, "Set LOW"]]) {
        const btn = el("button");
        btn.textContent = name;
        btn.setAttribute("aria-checked", String(b.outValue === v));
        btn.addEventListener("click", () => { b.outValue = v; b.value = v; commitBinding(b); renderValues(); closePopover(); });
        pop.appendChild(btn);
      }
      return;
    }
    if (b.mode === "pwm") {
      pop.innerHTML = "<h4>Show as</h4>";
      for (const [d, name] of [["percent", "Percent"], ["vavg", "Average voltage"]]) {
        const btn = el("button");
        btn.textContent = name;
        btn.setAttribute("aria-checked", String((b.display === "vavg" ? "vavg" : "percent") === d));
        btn.addEventListener("click", () => { b.display = d; save(); renderValues(); closePopover(); });
        pop.appendChild(btn);
      }
      pop.appendChild(el("div", "sep"));
      pop.insertAdjacentHTML("beforeend", "<h4>Frequency</h4>");
      for (const f of PWM_FREQS) {
        const fb = el("button");
        fb.textContent = fmtFreqLong(f);
        fb.setAttribute("aria-checked", String(b.pwmFreq === f));
        fb.addEventListener("click", () => { b.pwmFreq = f; commitBinding(b); openValueMenu(b, anchor); });
        pop.appendChild(fb);
      }
      return;
    }
    if (b.mode === "uart") {
      pop.innerHTML = "<h4>UART</h4>";
      const edit = el("button");
      edit.textContent = `Match text: “${b.uartMatch}”`;
      edit.addEventListener("click", () => { closePopover(); openPinMenu(b, anchor.closest(".block").querySelector(".block-pin")); });
      pop.appendChild(edit);
      pop.appendChild(el("div", "sep"));
    } else if (b.mode === "analog") {
      pop.innerHTML = "<h4>Show as</h4>";
      for (const [d, name] of [["raw", "Number (0–4095)"], ["voltage", "Voltage"], ["percent", "Percent"]]) {
        const btn = el("button");
        btn.textContent = name;
        btn.setAttribute("aria-checked", String(b.display === d));
        btn.addEventListener("click", () => { b.display = d; save(); renderValues(); closePopover(); });
        pop.appendChild(btn);
      }
      pop.appendChild(el("div", "sep"));
    } else {
      pop.innerHTML = "<h4>Digital</h4>";
      const inv = el("button");
      inv.textContent = "Invert HIGH / LOW";
      inv.setAttribute("aria-checked", String(b.invert));
      inv.addEventListener("click", () => { b.invert = !b.invert; save(); renderValues(); closePopover(); });
      pop.appendChild(inv);
      pop.appendChild(el("div", "sep"));
    }
    const spark = el("button");
    spark.textContent = "Sparkline";
    spark.setAttribute("aria-checked", String(b.sparkline));
    spark.addEventListener("click", () => {
      b.sparkline = !b.sparkline;
      if (!b.sparkline) b.hist = [];
      save();
      rerenderBlock(b);
      closePopover();
    });
    pop.appendChild(spark);

    if (b.sparkline) {
      const auto = el("button");
      auto.textContent = "Auto-scale";
      auto.setAttribute("aria-checked", String(b.autoScale));
      auto.addEventListener("click", () => { b.autoScale = !b.autoScale; save(); renderValues(); openValueMenu(b, anchor); });
      pop.appendChild(auto);
    }
  });
}

function rerenderBlock(b) {
  const n = nodes.get(b.id);
  if (!n) return;
  const fresh = renderBlock(b);
  n.wrap.replaceWith(fresh);
}

function commitBinding(b, pinAnchor, pop) {
  if (pinAnchor) paintPin(pinAnchor, b);
  else {
    const n = nodes.get(b.id);
    if (n) paintPin(n.wrap.querySelector(".block-pin"), b);
  }
  b.hist = [];
  save();
  renderValues();
  scheduleSync();
}

// ---- keep the device program in sync with the bindings --
function bindingsOf() {
  return state.blocks
    .filter((b) => b.pin != null)
    .map((b) => ({ pin: b.pin, mode: b.mode, value: b.outValue, pull: b.pull, atten: b.atten, pwmFreq: b.pwmFreq, pwmDuty: b.pwmDuty }));
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 350);
  if (state.demo) startDemo();
}

let syncing = null;
async function runSync() {
  if (device.state !== "running" && device.state !== "connected") return;
  // Pin blocks need a MicroPython telemetry program; UART blocks just read the
  // existing serial output, so nothing to push if there are no pin bindings.
  if (!bindingsOf().length || !device.microPython) return;
  if (syncing) { await syncing.catch(() => {}); } // serialize overlapping calls
  syncing = (async () => {
    const src = generateProgram(bindingsOf());
    try {
      await device.run(src);
      toast("Updated code on the ESP32");
    } catch (e) {
      toast("Couldn't update device: " + e.message);
    }
  })();
  const p = syncing;
  await p;
  if (syncing === p) syncing = null;
}

// ---- demo feed (no hardware) ---------------------------
let demoTimer = null;
function startDemo() {
  clearInterval(demoTimer);
  if (!state.demo) return;
  const phase = {};
  demoTimer = setInterval(() => {
    const t = Date.now() / 1000;
    for (const b of state.blocks) {
      if (b.mode === "pwm") continue; // display shows the set duty directly
      if (b.mode === "uart") {
        if (!b.uartMatch) continue;
        phase[b.id] = phase[b.id] || Math.random() * 6;
        setValue(b, Math.round((40 + Math.sin(t * 0.6 + phase[b.id]) * 25) * 10) / 10);
        continue;
      }
      if (b.pin == null) continue;
      if (b.mode === "out") { setValue(b, b.outValue); continue; }
      if (b.mode === "analog") {
        phase[b.id] = phase[b.id] || Math.random() * 6;
        const base = 2048 + Math.sin(t * 0.7 + phase[b.id]) * 1400;
        setValue(b, Math.max(0, Math.min(ADC_MAX, Math.round(base + (Math.random() - 0.5) * 200))));
      } else {
        setValue(b, Math.sin(t * 1.3 + (+b.id)) > 0.4 ? 1 : 0);
      }
    }
    renderValues();
  }, 120);
}
function stopDemo() { clearInterval(demoTimer); demoTimer = null; }

// ---- device button / flashing flow -------------------
deviceBtn.addEventListener("click", openDeviceMenu);

function openDeviceMenu() {
  openPopover(deviceBtn, (pop) => {
    pop.innerHTML = "<h4>Device</h4>";
    const add = (name, fn, checked) => {
      const btn = el("button");
      btn.textContent = name;
      if (checked !== undefined) btn.setAttribute("aria-checked", String(checked));
      btn.addEventListener("click", async () => { closePopover(); try { await fn(); } catch (e) { toast(e.message || String(e)); } });
      pop.appendChild(btn);
      return btn;
    };
    if (device.state === "disconnected") {
      if (device.supported) {
        add("Connect an ESP32…", connectFlow);
      } else {
        const b = add("Web Serial unavailable", () => {});
        b.disabled = true;
        b.style.opacity = 0.5;
      }
    } else {
      add("Re-flash MicroPython", doFlash);
      add("Push code now", runSync);
      add("Disconnect", () => device.disconnect());
    }
    pop.appendChild(el("div", "sep"));
    add("Webcam background", () => setWebcam(!state.webcam), state.webcam);
    add("Demo data (no device)", toggleDemo, state.demo);
    add("Load firmware file…", pickFirmware);
  });
}

function toggleDemo() {
  state.demo = !state.demo;
  save();
  if (state.demo) { startDemo(); toast("Demo data on"); } else { stopDemo(); renderValues(); }
  device.onStatus(device.state);
}

async function connectFlow() {
  try {
    await device.connect();
  } catch (e) {
    device.setStatus("disconnected");
    if (e && (e.name === "NotFoundError" || e.name === "AbortError")) return; // picker dismissed
    toast(e.message || String(e));
    return;
  }
  try {
    const needsMP = state.blocks.some((b) => b.pin != null);
    if (!needsMP) {
      // UART-only board: don't poke it with REPL bytes, just read the serial
      device.setStatus("connected");
      toast("Connected — reading serial");
      return;
    }
    const hasMP = await device.detectMicroPython();
    if (hasMP) {
      device.setStatus("connected");
      toast("MicroPython detected");
    } else {
      device.setStatus("connected");
      toast("No MicroPython on this board");
      if (confirm("This board isn't running MicroPython.\n\nFlash the bundled firmware now? (ESP32-S3)")) {
        await doFlash();
      }
    }
    await runSync();
  } catch (e) {
    device.setStatus("error");
    toast(e.message || String(e));
  }
}

async function doFlash() {
  showProgress(0, "starting");
  try {
    await device.flashMicroPython({ onProgress: showProgress });
    hideProgress();
    toast("MicroPython flashed ✓");
    await runSync();
  } catch (e) {
    hideProgress();
    toast(e.message || String(e));
  }
}

async function pickFirmware() {
  const inp = el("input");
  inp.type = "file";
  inp.accept = ".bin";
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    if (!f) return;
    const data = new Uint8Array(await f.arrayBuffer());
    if (device.state === "disconnected") await device.connect();
    showProgress(0, "starting");
    try {
      await device.flashMicroPython({ firmware: data, onProgress: showProgress });
      hideProgress();
      toast("Flashed " + f.name);
      await runSync();
    } catch (e) {
      hideProgress();
      toast(e.message || String(e));
    }
  });
  inp.click();
}

function showProgress(pct, msg) {
  progressEl.hidden = false;
  progressEl.style.setProperty("--p", pct + "%");
  $(".msg", progressEl).textContent = msg ? `${msg} · ${pct}%` : pct + "%";
}
function hideProgress() { progressEl.hidden = true; }

// ---- toast --------------------------------------------
let toastT = null;
function toast(msg) {
  toastEl.textContent = "";
  const d = el("div");
  d.textContent = msg;
  toastEl.appendChild(d);
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.textContent = ""), 3200);
}

// ---- misc helpers -----------------------------------
function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
function elNS(tag, cls) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (cls) n.setAttribute("class", cls);
  return n;
}

// ---- webcam background -----------------------------
let webcamStream = null;
async function setWebcam(on, silent) {
  state.webcam = on;
  save();
  const existing = $("#webcam");
  if (!on) {
    if (webcamStream) webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
    if (existing) existing.remove();
    document.body.classList.remove("webcam");
    return;
  }
  if (existing) return;
  const video = el("video");
  video.id = "webcam";
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  document.body.prepend(video);
  document.body.classList.add("webcam");
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = webcamStream;
    await video.play();
  } catch (e) {
    if (!silent) toast("Camera: " + (e.message || e.name));
    setWebcam(false);
  }
}

// ---- title editing ---------------------------------
bindEditable(titleEl, (text) => { state.title = text; save(); });

// ---- wire up --------------------------------------
addBtn.addEventListener("click", addBlock);
document.addEventListener("keydown", (e) => {
  if (e.target.isContentEditable || e.target.tagName === "INPUT") return;
  if (e.key === "n") addBlock();
});
window.addEventListener("resize", renderValues);

render();
device.onStatus("disconnected");
if (state.demo) startDemo();
if (state.webcam) setWebcam(true, true);
