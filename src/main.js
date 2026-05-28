import "./styles.css";
import { distance, isFist } from "./gesture.js";

const $ = (selector) => {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
};

const canvas = $("#game-canvas");
const context = canvas.getContext("2d");
const app = $("#app");
const wallTargetLayer = $("#wall-target-layer");
const targetPanel = $(".target-panel");
const video = $("#camera-video");
const handOverlay = $("#hand-overlay");
const handContext = handOverlay.getContext("2d");
const cameraButton = $("#camera-button");
const resetButton = $("#reset-button");
const smashButton = $("#smash-button");
const soundButton = $("#sound-button");
const pinNoteButton = $("#pin-note-button");
const photoButton = $("#photo-button");
const photoInput = $("#photo-input");
const clearTargetsButton = $("#clear-targets-button");
const targetText = $("#target-text");
const cameraState = $("#camera-state");
const phaseLabel = $("#phase-label");
const gestureLabel = $("#gesture-label");
const smashCount = $("#release-count");
const toast = $("#toast");

const PHASES = {
  READY: "ready",
  AIMING: "aiming",
  HOLDING: "holding",
  THROWING: "throwing",
  SMASHED: "smashed"
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const now = () => performance.now();

const makeBottle = () => ({
  x: window.innerWidth * 0.5,
  y: window.innerHeight * 0.52,
  width: clamp(window.innerWidth * 0.14, 92, 150),
  height: clamp(window.innerHeight * 0.36, 230, 340),
  tilt: (Math.random() - 0.5) * 0.16,
  hue: 174 + Math.random() * 24,
  seed: Math.random() * 1000,
  alive: true,
  spawnAt: now()
});

const state = {
  phase: PHASES.READY,
  cameraActive: false,
  handLandmarker: null,
  stream: null,
  lastVideoTime: -1,
  lastOverlayAt: 0,
  smoothedPoint: null,
  previousWrist: null,
  previousFist: false,
  previousPointer: null,
  pointerDown: false,
  grabbed: false,
  soundEnabled: true,
  smashes: 0,
  toastTimer: 0,
  dpr: 1,
  bottle: null,
  shards: [],
  dust: [],
  ripples: [],
  glassTrails: [],
  impactMarks: [],
  targets: [],
  targetSequence: 0,
  flightPath: [],
  hammerTrails: [],
  lastSmashAt: 0,
  throwStartedAt: 0,
  lastTrailAt: 0,
  throwVelocity: { x: 0, y: 0 }
};

class SoundEngine {
  constructor() {
    this.context = null;
    this.master = null;
  }

  async unlock() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        return false;
      }
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    return this.context.state === "running";
  }

  play(name) {
    if (!state.soundEnabled || !this.context || this.context.state !== "running") {
      return;
    }
    if (name === "smash") {
      this.glassSmash();
      return;
    }
    const patterns = {
      tap: [[220, 0, 0.035, "square", 0.08]],
      spawn: [[360, 0, 0.06, "sine", 0.08], [520, 0.05, 0.07, "triangle", 0.07]],
      grab: [[180, 0, 0.045, "square", 0.1], [260, 0.035, 0.055, "triangle", 0.08]],
      throw: [[260, 0, 0.06, "sawtooth", 0.12], [540, 0.055, 0.08, "triangle", 0.08]]
    };
    (patterns[name] || patterns.tap).forEach(([frequency, delay, duration, type, volume]) => {
      this.tone(frequency, delay, duration, type, volume);
    });
  }

  glassSmash() {
    this.tone(74, 0, 0.13, "sawtooth", 0.28);
    this.tone(126, 0.018, 0.08, "triangle", 0.12);
    this.noiseBurst(0.006, 0.16, 0.22, "highpass", 1800, 0.7);
    this.noiseBurst(0.026, 0.11, 0.18, "bandpass", 4200, 2.6);
    this.noiseBurst(0.072, 0.09, 0.1, "bandpass", 7600, 3.2);

    for (let i = 0; i < 18; i += 1) {
      const delay = 0.018 + Math.random() * 0.22;
      const frequency = 1500 + Math.random() * 5200;
      const duration = 0.035 + Math.random() * 0.09;
      const volume = 0.018 + Math.random() * 0.048;
      this.glassPing(frequency, delay, duration, volume, Math.random() * 2 - 1);
    }
  }

  tone(frequency, delay, duration, type, volume) {
    const at = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * 0.68), at + duration);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.03);
  }

  noiseBurst(delay, duration, volume, filterType, frequency, q) {
    const sampleRate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const decay = 1 - i / data.length;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }

    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const at = this.context.currentTime + delay;

    source.buffer = buffer;
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, at);
    filter.Q.setValueAtTime(q, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(at);
    source.stop(at + duration + 0.02);
  }

  glassPing(frequency, delay, duration, volume, panValue) {
    const at = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner?.();

    oscillator.type = Math.random() > 0.45 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * (0.82 + Math.random() * 0.24), at + duration);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(frequency, at);
    filter.Q.setValueAtTime(8 + Math.random() * 8, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    oscillator.connect(filter);
    filter.connect(gain);
    if (panner) {
      panner.pan.setValueAtTime(panValue, at);
      gain.connect(panner);
      panner.connect(this.master);
    } else {
      gain.connect(this.master);
    }
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }
}

const sound = new SoundEngine();

const showToast = (message, duration = 2400) => {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.add("hidden"), duration);
};

const setPhase = (phase, label) => {
  state.phase = phase;
  phaseLabel.textContent = label;
};

const resize = () => {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.floor(width * state.dpr);
  canvas.height = Math.floor(height * state.dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  if (state.bottle?.alive) {
    state.bottle.x = width * 0.5;
    state.bottle.y = height * 0.52;
    state.bottle.width = clamp(width * 0.14, 92, 150);
    state.bottle.height = clamp(height * 0.36, 230, 340);
  }
};

const spawnBottle = () => {
  state.bottle = makeBottle();
  state.shards = [];
  state.dust = [];
  state.ripples = [];
  state.glassTrails = [];
  state.flightPath = [];
  state.grabbed = false;
  state.throwVelocity = { x: 0, y: 0 };
  setPhase(PHASES.AIMING, "瞄准玻璃瓶");
  gestureLabel.textContent = state.targets.length
    ? "抓住瓶子，朝墙上的目标投掷。"
    : "先贴便利贴/照片，或直接抓住瓶子投掷。";
  sound.play("spawn");
};

const resetRound = () => {
  spawnBottle();
  state.smoothedPoint = null;
  state.previousWrist = null;
  state.previousFist = false;
};

const targetSlots = [
  { x: 0.42, y: 0.24, r: -4 },
  { x: 0.58, y: 0.26, r: 3 },
  { x: 0.35, y: 0.42, r: 5 },
  { x: 0.66, y: 0.43, r: -6 },
  { x: 0.49, y: 0.36, r: 2 },
  { x: 0.28, y: 0.3, r: -2 }
];

const clampTargetPosition = (target) => {
  const rect = target.element.getBoundingClientRect();
  const width = rect.width || target.width || 140;
  const height = rect.height || target.height || 112;
  const margin = 16;
  target.x = clamp(target.x, margin, window.innerWidth - width - margin);
  target.y = clamp(target.y, Math.max(86, window.innerHeight * 0.13), window.innerHeight - height - 132);
  target.width = width;
  target.height = height;
};

const applyTargetPosition = (target) => {
  target.element.style.setProperty("--target-x", `${Math.round(target.x)}px`);
  target.element.style.setProperty("--target-y", `${Math.round(target.y)}px`);
  target.element.style.setProperty("--target-rotate", `${target.rotate}deg`);
};

const nextTargetPlacement = () => {
  const slot = targetSlots[state.targetSequence % targetSlots.length];
  state.targetSequence += 1;
  return {
    x: window.innerWidth * slot.x - 70 + (Math.random() - 0.5) * 22,
    y: window.innerHeight * slot.y - 56 + (Math.random() - 0.5) * 18,
    rotate: slot.r + (Math.random() - 0.5) * 2
  };
};

const removeTarget = (id) => {
  const target = state.targets.find((item) => item.id === id);
  if (!target) {
    return;
  }
  if (target.url) {
    URL.revokeObjectURL(target.url);
  }
  target.element.remove();
  state.targets = state.targets.filter((item) => item.id !== id);
};

const enableTargetDrag = (target) => {
  let dragStart = null;
  target.element.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".target-remove") || target.hit) {
      return;
    }
    event.stopPropagation();
    dragStart = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      targetX: target.x,
      targetY: target.y
    };
    target.element.classList.add("is-dragging");
    target.element.setPointerCapture(event.pointerId);
  });
  target.element.addEventListener("pointermove", (event) => {
    if (!dragStart || dragStart.pointerId !== event.pointerId) {
      return;
    }
    target.x = dragStart.targetX + event.clientX - dragStart.pointerX;
    target.y = dragStart.targetY + event.clientY - dragStart.pointerY;
    clampTargetPosition(target);
    applyTargetPosition(target);
  });
  const finishDrag = (event) => {
    if (!dragStart || dragStart.pointerId !== event.pointerId) {
      return;
    }
    target.element.classList.remove("is-dragging");
    target.element.releasePointerCapture(event.pointerId);
    dragStart = null;
  };
  target.element.addEventListener("pointerup", finishDrag);
  target.element.addEventListener("pointercancel", finishDrag);
};

const addWallTarget = ({ type, text, url }) => {
  const placement = nextTargetPlacement();
  const id = `target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const element = document.createElement("article");
  element.className = `wall-target target-${type}`;
  element.setAttribute("aria-label", type === "photo" ? "墙面照片" : `便利贴：${text}`);

  const removeButton = document.createElement("button");
  removeButton.className = "target-remove";
  removeButton.type = "button";
  removeButton.setAttribute("aria-label", "移除目标");
  removeButton.textContent = "×";
  removeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    removeTarget(id);
  });
  element.append(removeButton);

  if (type === "photo") {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "上传的墙面目标照片";
    const caption = document.createElement("span");
    caption.className = "photo-caption";
    caption.textContent = "砸掉它";
    element.append(image, caption);
  } else {
    const content = document.createElement("span");
    content.textContent = text;
    element.append(content);
  }

  const target = {
    id,
    type,
    text,
    url,
    element,
    hit: false,
    x: placement.x,
    y: placement.y,
    rotate: placement.rotate,
    width: type === "photo" ? 158 : 140,
    height: type === "photo" ? 142 : 112
  };
  wallTargetLayer.append(element);
  clampTargetPosition(target);
  applyTargetPosition(target);
  enableTargetDrag(target);
  state.targets.push(target);
  showToast(type === "photo" ? "照片已经钉到墙上。" : "便利贴已经钉到墙上。", 1400);
  return target;
};

const pinNote = () => {
  const text = targetText.value.trim();
  if (!text) {
    showToast("先写一个想砸掉的东西。");
    targetText.focus();
    return;
  }
  addWallTarget({ type: "note", text });
  targetText.value = "";
  gestureLabel.textContent = "目标贴好了，抓住瓶子向墙上投掷。";
};

const pinPhoto = (file) => {
  if (!file?.type?.startsWith("image/")) {
    showToast("请选择一张照片。");
    return;
  }
  const url = URL.createObjectURL(file);
  addWallTarget({ type: "photo", text: file.name || "photo", url });
  gestureLabel.textContent = "照片贴好了，抓住瓶子向墙上投掷。";
};

const clearTargets = () => {
  state.targets.forEach((target) => {
    if (target.url) {
      URL.revokeObjectURL(target.url);
    }
    target.element.remove();
  });
  state.targets = [];
  showToast("墙面清空了。", 1400);
};

const hitWallTargets = (origin, force) => {
  const candidates = state.targets
    .filter((target) => !target.hit)
    .map((target) => {
      const rect = target.element.getBoundingClientRect();
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const dx = origin.x - center.x;
      const dy = origin.y - center.y;
      const expandedX = rect.width * 0.72 + 86 * force;
      const expandedY = rect.height * 0.72 + 72 * force;
      return {
        target,
        distance: Math.hypot(dx, dy),
        hittable: Math.abs(dx) < expandedX && Math.abs(dy) < expandedY,
        dx,
        dy
      };
    })
    .filter((candidate) => candidate.hittable)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, force > 1.8 ? 2 : 1);

  candidates.forEach(({ target, dx, dy }) => {
    target.hit = true;
    target.element.style.setProperty("--hit-x", `${Math.round(clamp(dx * 0.34, -44, 44))}px`);
    target.element.style.setProperty("--hit-y", `${Math.round(clamp(dy * 0.28 - 34, -62, 20))}px`);
    target.element.classList.add("is-hit");
    window.setTimeout(() => removeTarget(target.id), 840);
  });
};

const pointFromLandmark = (landmark) => ({
  x: (1 - landmark.x) * window.innerWidth,
  y: landmark.y * window.innerHeight
});

const palmPointFromLandmarks = (landmarks) => {
  const anchors = [0, 5, 9, 13, 17].map((index) => pointFromLandmark(landmarks[index]));
  return {
    x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length,
    y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length
  };
};

const bottleHitRadius = () => Math.max(state.bottle.width * 0.72, 86);

const isNearBottle = (point) => {
  if (!state.bottle?.alive) {
    return false;
  }
  const impact = {
    x: state.bottle.x,
    y: state.bottle.y - state.bottle.height * 0.04
  };
  return distance(point, impact) < bottleHitRadius();
};

const addMotionTrail = (point, strong = false) => {
  state.hammerTrails.push({
    x: point.x,
    y: point.y,
    radius: strong ? 34 : 22,
    age: 0,
    life: strong ? 0.32 : 0.2
  });
};

const makeShardShape = (size) => {
  const points = [];
  const count = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
    const radius = size * (0.42 + Math.random() * 0.72);
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
};

const addBottleTrail = () => {
  if (!state.bottle?.alive) {
    return;
  }
  const timestamp = now();
  if (timestamp - state.lastTrailAt < 44) {
    return;
  }
  state.lastTrailAt = timestamp;
  state.glassTrails.push({
    x: state.bottle.x,
    y: state.bottle.y,
    width: state.bottle.width,
    height: state.bottle.height,
    tilt: state.bottle.tilt,
    age: 0,
    life: 0.34
  });
  state.flightPath.push({ x: state.bottle.x, y: state.bottle.y, age: 0, life: 0.8 });
  if (state.flightPath.length > 18) {
    state.flightPath.shift();
  }
};

const grabBottle = (point) => {
  if (!state.bottle?.alive || state.phase === PHASES.THROWING || state.phase === PHASES.SMASHED) {
    return;
  }
  state.grabbed = true;
  setPhase(PHASES.HOLDING, "握住瓶子");
  gestureLabel.textContent = "已经抓住瓶子，向左/右/上方快速甩出去。";
  state.bottle.x = lerp(state.bottle.x, point.x, 0.5);
  state.bottle.y = lerp(state.bottle.y, point.y + state.bottle.height * 0.08, 0.5);
  sound.play("grab");
};

const throwBottle = (velocity = { x: 18, y: -8 }) => {
  if (!state.bottle?.alive || state.phase === PHASES.THROWING || state.phase === PHASES.SMASHED) {
    return;
  }
  const speed = Math.max(1, Math.hypot(velocity.x, velocity.y));
  const scale = clamp(speed / 34, 0.9, 2.6);
  state.throwVelocity = {
    x: (velocity.x / speed) * (9 + scale * 6),
    y: (velocity.y / speed) * (8 + scale * 5) - 3.2
  };
  state.grabbed = false;
  state.throwStartedAt = now();
  state.lastTrailAt = 0;
  state.flightPath = [{ x: state.bottle.x, y: state.bottle.y, age: 0, life: 0.8 }];
  state.bottle.spin = (velocity.x > 0 ? 1 : -1) * (0.13 + scale * 0.08);
  setPhase(PHASES.THROWING, "投掷中");
  gestureLabel.textContent = "瓶子飞出去了，等它撞碎。";
  sound.play("throw");
};

const smashBottle = (impactPoint, force = 1) => {
  if (!state.bottle?.alive || now() - state.lastSmashAt < 420) {
    return;
  }
  state.lastSmashAt = now();
  state.bottle.alive = false;
  state.grabbed = false;
  state.smashes += 1;
  smashCount.textContent = String(state.smashes);
  setPhase(PHASES.SMASHED, "玻璃碎裂");
  gestureLabel.textContent = "撞碎了。下一瓶马上出现。";

  const bottle = state.bottle;
  const origin = {
    x: impactPoint?.x ?? bottle.x,
    y: impactPoint?.y ?? bottle.y
  };
  hitWallTargets(origin, force);
  const shardCount = Math.round(48 + force * 24);
  const incomingAngle = Math.atan2(state.throwVelocity.y || -1, state.throwVelocity.x || 1);
  state.impactMarks.unshift({
    x: origin.x,
    y: origin.y,
    radius: 34 + force * 26,
    cracks: Array.from({ length: 9 }, (_, index) => ({
      angle: (index / 9) * Math.PI * 2 + (Math.random() - 0.5) * 0.5,
      length: 32 + Math.random() * (52 + force * 24),
      kink: (Math.random() - 0.5) * 0.65
    })),
    age: 0,
    life: 5.5
  });
  state.impactMarks = state.impactMarks.slice(0, 4);
  for (let i = 0; i < shardCount; i += 1) {
    const angle = incomingAngle + Math.PI + (Math.random() - 0.5) * (2.2 + Math.random() * 0.9);
    const speed = 2.2 + Math.random() * (7 + force * 5.6);
    const size = 3 + Math.random() * 16 * (Math.random() > 0.82 ? 1.55 : 1);
    state.shards.push({
      x: origin.x + (Math.random() - 0.5) * bottle.width * 0.7,
      y: origin.y + (Math.random() - 0.5) * bottle.height * 0.35,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - Math.random() * 2.4,
      size,
      shape: makeShardShape(size),
      spin: (Math.random() - 0.5) * 0.42,
      rotation: Math.random() * Math.PI,
      bounced: false,
      floorY: window.innerHeight * 0.78 + Math.random() * 10,
      age: 0,
      life: 0.85 + Math.random() * 1.1,
      hue: bottle.hue + Math.random() * 18
    });
  }
  for (let i = 0; i < 18; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.5 + Math.random() * 3.2;
    state.dust.push({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 18 + Math.random() * 58,
      age: 0,
      life: 0.9 + Math.random() * 1.1
    });
  }
  state.ripples.push({ x: origin.x, y: origin.y, radius: 20, age: 0, life: 0.42 });
  sound.play("smash");
  window.setTimeout(spawnBottle, 1120);
};

const updateThrowInput = (point, velocity, fist) => {
  if (!state.bottle?.alive) {
    return;
  }
  const speed = velocity ? Math.hypot(velocity.x, velocity.y) : 0;
  if (fist) {
    addMotionTrail(point, speed > 18);
    if (state.grabbed) {
      state.bottle.x = lerp(state.bottle.x, point.x, 0.42);
      state.bottle.y = lerp(state.bottle.y, point.y + state.bottle.height * 0.08, 0.42);
      state.bottle.tilt = clamp(velocity.x / 120, -0.42, 0.42);
      if (speed > Math.max(34, window.innerWidth * 0.028)) {
        throwBottle(velocity);
      }
    } else if (isNearBottle(point)) {
      grabBottle(point);
    } else {
      gestureLabel.textContent = "握拳移到瓶子上，抓住后甩出去。";
    }
  } else if (state.grabbed) {
    throwBottle(velocity);
  }
};

const drawHandOverlay = (results) => {
  const rect = handOverlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  handOverlay.width = Math.max(1, Math.floor(rect.width * dpr));
  handOverlay.height = Math.max(1, Math.floor(rect.height * dpr));
  handContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  handContext.clearRect(0, 0, rect.width, rect.height);
  if (video.readyState >= 2) {
    handContext.save();
    handContext.scale(-1, 1);
    handContext.drawImage(video, -rect.width, 0, rect.width, rect.height);
    handContext.restore();
  }
  const landmarks = results.landmarks?.[0];
  if (!landmarks) {
    return;
  }
  handContext.lineWidth = 2;
  handContext.strokeStyle = "rgba(142, 241, 255, 0.86)";
  handContext.fillStyle = "rgba(255, 214, 120, 0.92)";
  handContext.beginPath();
  HAND_CONNECTIONS.forEach(([from, to]) => {
    const a = landmarks[from];
    const b = landmarks[to];
    handContext.moveTo((1 - a.x) * rect.width, a.y * rect.height);
    handContext.lineTo((1 - b.x) * rect.width, b.y * rect.height);
  });
  handContext.stroke();
  landmarks.forEach((point, index) => {
    handContext.beginPath();
    handContext.arc((1 - point.x) * rect.width, point.y * rect.height, index === 0 || index === 8 ? 4.4 : 2.5, 0, Math.PI * 2);
    handContext.fill();
  });
};

const handleLandmarks = (landmarks) => {
  const palmPoint = palmPointFromLandmarks(landmarks);
  const fist = isFist(landmarks);
  if (!state.smoothedPoint) {
    state.smoothedPoint = palmPoint;
  } else {
    state.smoothedPoint = {
      x: lerp(state.smoothedPoint.x, palmPoint.x, 0.42),
      y: lerp(state.smoothedPoint.y, palmPoint.y, 0.42)
    };
  }
  const velocity = state.previousWrist
    ? { x: palmPoint.x - state.previousWrist.x, y: palmPoint.y - state.previousWrist.y }
    : { x: 0, y: 0 };
  updateThrowInput(state.smoothedPoint, velocity, fist);
  if (!fist && state.bottle?.alive) {
    gestureLabel.textContent = "握拳抓住瓶子，再做投掷动作。";
  }
  state.previousWrist = palmPoint;
  state.previousFist = fist;
};

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), ms);
    })
  ]);

const startCamera = async () => {
  try {
    await sound.unlock();
    cameraState.textContent = "加载手势模型";
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const assetBase = import.meta.env.BASE_URL;
    const vision = await FilesetResolver.forVisionTasks(`${assetBase}wasm`);
    state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${assetBase}models/hand_landmarker.task`,
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    });

    cameraState.textContent = "请求摄像头";
    state.stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 720 },
          facingMode: "user"
        },
        audio: false
      }),
      8000,
      "Camera permission timed out"
    );
    video.srcObject = state.stream;
    await withTimeout(video.play(), 5000, "Camera preview timed out");
    state.cameraActive = true;
    cameraState.textContent = "摄像头已连接";
    cameraButton.textContent = "摄像头已开";
    cameraButton.disabled = true;
    gestureLabel.textContent = "握拳抓住玻璃瓶，向外快速甩手投掷。";
    showToast("摄像头只在本地用于手势追踪，不保存视频。");
  } catch (error) {
    console.warn(error);
    state.cameraActive = false;
    cameraState.textContent = "鼠标/触控模式";
    gestureLabel.textContent = "摄像头暂不可用，可按住瓶子拖拽后松手投掷。";
    showToast("摄像头不可用，已切换到鼠标/触控回退。");
  }
};

const updateCamera = () => {
  if (!state.cameraActive || !state.handLandmarker || video.readyState < 2) {
    return;
  }
  if (video.currentTime === state.lastVideoTime) {
    return;
  }
  state.lastVideoTime = video.currentTime;
  const results = state.handLandmarker.detectForVideo(video, now());
  const timestamp = now();
  if (timestamp - state.lastOverlayAt > 80) {
    drawHandOverlay(results);
    state.lastOverlayAt = timestamp;
  }
  const landmarks = results.landmarks?.[0];
  if (landmarks) {
    handleLandmarks(landmarks);
  } else if (state.bottle?.alive) {
    gestureLabel.textContent = "把手放回镜头，握拳抓瓶再投掷。";
  }
};

const updateFx = (delta) => {
  if (state.phase === PHASES.THROWING && state.bottle?.alive) {
    addBottleTrail();
    state.bottle.x += state.throwVelocity.x * delta * 60;
    state.bottle.y += state.throwVelocity.y * delta * 60;
    state.throwVelocity.x *= 0.994;
    state.throwVelocity.y = state.throwVelocity.y * 0.996 + 0.21 * delta * 60;
    state.bottle.tilt += state.bottle.spin || 0.14;
    const elapsed = now() - state.throwStartedAt;
    const hitWall = state.bottle.x < window.innerWidth * 0.18 || state.bottle.x > window.innerWidth * 0.74;
    const hitFloor = state.bottle.y > window.innerHeight * 0.78;
    if ((elapsed > 260 && hitWall) || (elapsed > 520 && hitFloor) || elapsed > 980) {
      smashBottle({
        x: clamp(state.bottle.x, window.innerWidth * 0.18, window.innerWidth * 0.74),
        y: clamp(state.bottle.y, window.innerHeight * 0.16, window.innerHeight * 0.72)
      }, clamp(Math.hypot(state.throwVelocity.x, state.throwVelocity.y) / 8, 1.1, 2.8));
    }
  }
  state.shards = state.shards.filter((shard) => {
    shard.age += delta;
    shard.vx *= 0.988;
    shard.vy = shard.vy * 0.988 + 0.12 * delta * 60;
    shard.x += shard.vx * delta * 60;
    shard.y += shard.vy * delta * 60;
    shard.rotation += shard.spin * delta * 60;
    if (!shard.bounced && shard.y > shard.floorY) {
      shard.y = shard.floorY;
      shard.vy *= -0.34;
      shard.vx *= 0.72;
      shard.spin *= 0.62;
      shard.bounced = true;
    }
    return shard.age < shard.life;
  });
  state.dust = state.dust.filter((puff) => {
    puff.age += delta;
    puff.x += puff.vx * delta * 60;
    puff.y += puff.vy * delta * 60;
    puff.radius += delta * 14;
    return puff.age < puff.life;
  });
  state.ripples = state.ripples.filter((ripple) => {
    ripple.age += delta;
    ripple.radius += delta * 440;
    return ripple.age < ripple.life;
  });
  state.hammerTrails = state.hammerTrails.filter((trail) => {
    trail.age += delta;
    trail.radius += delta * 100;
    return trail.age < trail.life;
  });
  state.glassTrails = state.glassTrails.filter((trail) => {
    trail.age += delta;
    return trail.age < trail.life;
  });
  state.flightPath = state.flightPath.filter((point) => {
    point.age += delta;
    return point.age < point.life;
  });
  state.impactMarks = state.impactMarks.filter((mark) => {
    mark.age += delta;
    return mark.age < mark.life;
  });
};

const drawBackground = (time) => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  context.clearRect(0, 0, width, height);

  context.save();
  const vignette = context.createRadialGradient(width * 0.5, height * 0.42, height * 0.08, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
  vignette.addColorStop(0, "rgba(7, 11, 18, 0)");
  vignette.addColorStop(0.64, "rgba(7, 11, 18, 0.18)");
  vignette.addColorStop(1, "rgba(1, 3, 8, 0.72)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
  context.restore();

  context.save();
  context.globalAlpha = 0.16;
  for (let i = 0; i < 34; i += 1) {
    const x = ((i * 173 + time * 0.018) % (width + 80)) - 40;
    const y = (Math.sin(i * 9.7 + time * 0.001) * 0.5 + 0.5) * height;
    context.fillStyle = i % 3 === 0 ? "#8ef1ff" : "#ffffff";
    context.beginPath();
    context.arc(x, y, 1 + (i % 4) * 0.35, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();

  context.save();
  context.globalAlpha = 0.2 + Math.sin(time * 0.002) * 0.03;
  const wallGlow = context.createRadialGradient(width * 0.5, height * 0.36, 0, width * 0.5, height * 0.36, width * 0.24);
  wallGlow.addColorStop(0, "rgba(142, 241, 255, 0.16)");
  wallGlow.addColorStop(0.58, "rgba(142, 241, 255, 0.04)");
  wallGlow.addColorStop(1, "rgba(142, 241, 255, 0)");
  context.fillStyle = wallGlow;
  context.fillRect(0, 0, width, height);
  context.restore();
};

const drawImpactMarks = () => {
  state.impactMarks.forEach((mark) => {
    const alpha = clamp(1 - mark.age / mark.life, 0, 1);
    context.save();
    context.globalAlpha = alpha * 0.55;
    context.strokeStyle = "rgba(220, 245, 248, 0.72)";
    context.lineWidth = 1.2;
    context.shadowColor = "rgba(142, 241, 255, 0.45)";
    context.shadowBlur = 8;
    mark.cracks.forEach((crack) => {
      const mid = mark.radius * 0.42 + crack.length * 0.35;
      context.beginPath();
      context.moveTo(mark.x, mark.y);
      context.lineTo(
        mark.x + Math.cos(crack.angle + crack.kink * 0.35) * mid,
        mark.y + Math.sin(crack.angle + crack.kink * 0.35) * mid
      );
      context.lineTo(
        mark.x + Math.cos(crack.angle + crack.kink) * crack.length,
        mark.y + Math.sin(crack.angle + crack.kink) * crack.length
      );
      context.stroke();
    });
    context.globalAlpha = alpha * 0.18;
    context.beginPath();
    context.arc(mark.x, mark.y, mark.radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  });
};

const drawFlightPath = () => {
  if (state.flightPath.length < 2) {
    return;
  }
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(255, 209, 95, 0.55)";
  context.shadowBlur = 18;
  for (let i = 1; i < state.flightPath.length; i += 1) {
    const prev = state.flightPath[i - 1];
    const point = state.flightPath[i];
    const alpha = clamp(1 - point.age / point.life, 0, 1) * (i / state.flightPath.length) * 0.42;
    context.globalAlpha = alpha;
    context.strokeStyle = "#ffd15f";
    context.lineWidth = 2 + i * 0.12;
    context.beginPath();
    context.moveTo(prev.x, prev.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.restore();
};

const drawBottleTrails = () => {
  state.glassTrails.forEach((trail) => {
    const alpha = clamp(1 - trail.age / trail.life, 0, 1);
    context.save();
    context.translate(trail.x, trail.y);
    context.rotate(trail.tilt);
    context.globalAlpha = alpha * 0.16;
    context.strokeStyle = "rgba(170, 250, 255, 0.95)";
    context.lineWidth = 5;
    context.shadowColor = "rgba(142, 241, 255, 0.9)";
    context.shadowBlur = 24;
    context.beginPath();
    context.roundRect(-trail.width * 0.34, -trail.height * 0.46, trail.width * 0.68, trail.height * 0.92, trail.width * 0.26);
    context.stroke();
    context.restore();
  });
};

const drawBottle = (time) => {
  const bottle = state.bottle;
  if (!bottle?.alive) {
    return;
  }
  const age = (time - bottle.spawnAt) / 1000;
  const pop = clamp(age * 4, 0, 1);
  const wobble = state.phase === PHASES.THROWING ? 0 : Math.sin(time * 0.004 + bottle.seed) * 0.018;
  const width = bottle.width * pop;
  const height = bottle.height * pop;
  const neckW = width * 0.36;
  const neckH = height * 0.34;
  const bodyH = height * 0.68;
  const bodyW = width;

  context.save();
  context.translate(bottle.x, bottle.y + (1 - pop) * 24);
  context.rotate(bottle.tilt + wobble);
  context.shadowColor = `hsla(${bottle.hue}, 95%, 64%, 0.5)`;
  context.shadowBlur = 34;

  const silhouette = new Path2D();
  silhouette.moveTo(-neckW * 0.5, -height * 0.5 + neckH * 0.08);
  silhouette.quadraticCurveTo(-neckW * 0.58, -height * 0.5, -neckW * 0.18, -height * 0.5);
  silhouette.lineTo(neckW * 0.24, -height * 0.5);
  silhouette.quadraticCurveTo(neckW * 0.58, -height * 0.47, neckW * 0.5, -height * 0.39);
  silhouette.lineTo(neckW * 0.43, -height * 0.18);
  silhouette.quadraticCurveTo(neckW * 0.42, -height * 0.08, bodyW * 0.38, -height * 0.02);
  silhouette.quadraticCurveTo(bodyW * 0.5, height * 0.04, bodyW * 0.48, height * 0.34);
  silhouette.quadraticCurveTo(bodyW * 0.46, height * 0.48, bodyW * 0.3, height * 0.5);
  silhouette.lineTo(-bodyW * 0.3, height * 0.5);
  silhouette.quadraticCurveTo(-bodyW * 0.46, height * 0.48, -bodyW * 0.48, height * 0.34);
  silhouette.quadraticCurveTo(-bodyW * 0.5, height * 0.04, -bodyW * 0.38, -height * 0.02);
  silhouette.quadraticCurveTo(-neckW * 0.43, -height * 0.08, -neckW * 0.43, -height * 0.18);
  silhouette.closePath();

  const glass = context.createLinearGradient(-bodyW / 2, 0, bodyW / 2, 0);
  glass.addColorStop(0, `hsla(${bottle.hue}, 82%, 42%, 0.18)`);
  glass.addColorStop(0.2, `hsla(${bottle.hue}, 94%, 78%, 0.5)`);
  glass.addColorStop(0.45, "rgba(255, 255, 255, 0.18)");
  glass.addColorStop(0.7, `hsla(${bottle.hue + 10}, 82%, 36%, 0.35)`);
  glass.addColorStop(1, `hsla(${bottle.hue + 18}, 90%, 26%, 0.32)`);
  context.fillStyle = glass;
  context.strokeStyle = `hsla(${bottle.hue}, 96%, 82%, 0.9)`;
  context.lineWidth = 3.2;
  context.fill(silhouette);
  context.stroke(silhouette);

  context.save();
  context.clip(silhouette);
  const liquid = context.createLinearGradient(0, height * 0.1, 0, height * 0.47);
  liquid.addColorStop(0, `hsla(${bottle.hue + 20}, 82%, 44%, 0.28)`);
  liquid.addColorStop(1, `hsla(${bottle.hue + 28}, 90%, 28%, 0.56)`);
  context.fillStyle = liquid;
  context.fillRect(-bodyW * 0.43, height * 0.1, bodyW * 0.86, bodyH * 0.3);
  context.globalAlpha = 0.28;
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.ellipse(-bodyW * 0.06, height * 0.1, bodyW * 0.37, 9, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.strokeStyle = "rgba(255, 255, 255, 0.64)";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(-bodyW * 0.23, -height * 0.34);
  context.quadraticCurveTo(-bodyW * 0.36, -height * 0.04, -bodyW * 0.28, height * 0.28);
  context.stroke();

  context.strokeStyle = "rgba(255, 255, 255, 0.3)";
  context.lineWidth = 1.4;
  [[-0.31, -0.08, -0.2, 0.38], [0.02, -0.18, 0.08, 0.44], [0.26, 0.02, 0.18, 0.36]].forEach(([x1, y1, x2, y2]) => {
    context.beginPath();
    context.moveTo(bodyW * x1, height * y1);
    context.lineTo(bodyW * x2, height * y2);
    context.stroke();
  });

  context.fillStyle = "rgba(255, 255, 255, 0.22)";
  context.beginPath();
  context.ellipse(0, height * 0.47, bodyW * 0.28, 8, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  context.globalAlpha = state.grabbed ? 0.9 : 0.42 + Math.sin(time * 0.006) * 0.12;
  context.strokeStyle = "rgba(255, 209, 95, 0.78)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(bottle.x, bottle.y - bottle.height * 0.04, bottleHitRadius(), 0, Math.PI * 2);
  context.stroke();
  context.restore();
};

const drawFx = () => {
  drawImpactMarks();
  drawFlightPath();
  state.dust.forEach((puff) => {
    const alpha = clamp(1 - puff.age / puff.life, 0, 1) * 0.22;
    const gradient = context.createRadialGradient(puff.x, puff.y, 0, puff.x, puff.y, puff.radius);
    gradient.addColorStop(0, "rgba(204, 225, 230, 0.78)");
    gradient.addColorStop(1, "rgba(204, 225, 230, 0)");
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(puff.x, puff.y, puff.radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  });

  state.ripples.forEach((ripple) => {
    const alpha = clamp(1 - ripple.age / ripple.life, 0, 1);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = "#ffd15f";
    context.lineWidth = 4;
    context.shadowColor = "#ffd15f";
    context.shadowBlur = 18;
    context.beginPath();
    context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  });

  state.shards.forEach((shard) => {
    const alpha = clamp(1 - shard.age / shard.life, 0, 1);
    context.save();
    context.translate(shard.x, shard.y);
    context.rotate(shard.rotation);
    context.globalAlpha = alpha;
    context.fillStyle = `hsla(${shard.hue}, 95%, 72%, 0.72)`;
    context.strokeStyle = "rgba(255, 255, 255, 0.72)";
    context.lineWidth = 1;
    context.shadowBlur = 0;
    context.beginPath();
    shard.shape.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.closePath();
    context.fill();
    context.stroke();
    if (!shard.bounced && alpha > 0.35) {
      context.globalAlpha = alpha * 0.7;
      context.strokeStyle = "rgba(255, 255, 255, 0.82)";
      context.lineWidth = 0.8;
      context.beginPath();
      context.moveTo(-shard.size * 0.2, 0);
      context.lineTo(shard.size * 0.32, -shard.size * 0.24);
      context.stroke();
    }
    context.restore();
  });

  state.hammerTrails.forEach((trail) => {
    const alpha = clamp(1 - trail.age / trail.life, 0, 1);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = "#ffdf7d";
    context.lineWidth = 3;
    context.shadowColor = "#ffdf7d";
    context.shadowBlur = 20;
    context.beginPath();
    context.arc(trail.x, trail.y, trail.radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  });
};

const drawCursor = () => {
  if (!state.smoothedPoint) {
    return;
  }
  context.save();
  context.globalAlpha = 0.88;
  context.fillStyle = "rgba(255, 209, 95, 0.18)";
  context.strokeStyle = "#ffd15f";
  context.lineWidth = 3;
  context.shadowColor = "#ffd15f";
  context.shadowBlur = 18;
  context.beginPath();
  context.arc(state.smoothedPoint.x, state.smoothedPoint.y, state.grabbed ? 31 : 24, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
};

let previousFrame = now();
const frame = () => {
  const current = now();
  const delta = Math.min(0.033, (current - previousFrame) / 1000);
  previousFrame = current;
  updateCamera();
  updateFx(delta);
  drawBackground(current);
  drawBottleTrails();
  drawBottle(current);
  drawFx();
  drawCursor();
  window.requestAnimationFrame(frame);
};

const pointerPoint = (event) => ({ x: event.clientX, y: event.clientY });

const isGamePointerTarget = (event) => !event.target.closest(
  "button, input, textarea, summary, .target-panel, .hud, .camera-panel, .wall-target"
);

const handlePointerSmash = async (event, moving = false) => {
  await sound.unlock();
  const point = pointerPoint(event);
  const velocity = state.previousPointer
    ? { x: point.x - state.previousPointer.x, y: point.y - state.previousPointer.y }
    : { x: 0, y: 0 };
  state.smoothedPoint = point;
  addMotionTrail(point, true);
  if (state.bottle?.alive && state.pointerDown && state.grabbed) {
    state.bottle.x = lerp(state.bottle.x, point.x, 0.5);
    state.bottle.y = lerp(state.bottle.y, point.y + state.bottle.height * 0.08, 0.5);
    state.bottle.tilt = clamp(velocity.x / 120, -0.42, 0.42);
  } else if (state.bottle?.alive && isNearBottle(point) && !moving) {
    grabBottle(point);
  }
  state.previousPointer = point;
  return velocity;
};

app.addEventListener("pointerdown", async (event) => {
  if (!isGamePointerTarget(event)) {
    return;
  }
  state.pointerDown = true;
  app.setPointerCapture(event.pointerId);
  state.previousPointer = pointerPoint(event);
  await handlePointerSmash(event, false);
});

app.addEventListener("pointermove", async (event) => {
  if (!state.pointerDown) {
    return;
  }
  await handlePointerSmash(event, true);
});

app.addEventListener("pointerup", async (event) => {
  if (!state.pointerDown) {
    return;
  }
  const velocity = await handlePointerSmash(event, true);
  if (state.grabbed) {
    throwBottle(Math.hypot(velocity.x, velocity.y) > 4 ? velocity : { x: 24, y: -12 });
  }
  state.pointerDown = false;
  state.previousPointer = null;
  app.releasePointerCapture(event.pointerId);
});

cameraButton.addEventListener("click", startCamera);
pinNoteButton.addEventListener("click", pinNote);
targetText.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    pinNote();
  }
});
photoButton.addEventListener("click", () => {
  photoInput.click();
});
photoInput.addEventListener("change", () => {
  const [file] = photoInput.files || [];
  pinPhoto(file);
  photoInput.value = "";
});
clearTargetsButton.addEventListener("click", clearTargets);
resetButton.addEventListener("click", () => {
  spawnBottle();
  showToast("换了一瓶，继续砸。");
});
smashButton.addEventListener("click", async () => {
  await sound.unlock();
  if (state.bottle?.alive) {
    throwBottle({ x: window.innerWidth * 0.035, y: -window.innerHeight * 0.018 });
  }
});
soundButton.addEventListener("click", async () => {
  await sound.unlock();
  state.soundEnabled = !state.soundEnabled;
  soundButton.textContent = state.soundEnabled ? "音效开" : "音效关";
  soundButton.setAttribute("aria-pressed", String(!state.soundEnabled));
  soundButton.classList.toggle("is-muted", !state.soundEnabled);
});

window.addEventListener("resize", () => {
  resize();
  state.targets.forEach((target) => {
    clampTargetPosition(target);
    applyTargetPosition(target);
  });
});
if (window.innerWidth <= 720) {
  targetPanel.open = false;
}
resize();
resetRound();
window.requestAnimationFrame(frame);
