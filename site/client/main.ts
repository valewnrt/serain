import { GLASS, SKY, VERTEX } from "./shaders.js";

/**
 * serain.si without a framework (D65). Everything here is decoration on top of
 * a page that works without it: the photographs stay where WebGL is missing,
 * every chat shows its last state without script, and reduced motion gets the
 * same page standing still. The DOM is only changed through classes and
 * attributes, never through HTML strings (the CSP enforces Trusted Types).
 */

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
document.documentElement.classList.add("js");

// ---------------------------------------------------------------- shaders

interface Scene {
  canvas: HTMLCanvasElement;
  section: HTMLElement;
  draw(time: number): void;
  resize(): void;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/** A spring toward the pointer: decorative tracking that has momentum instead of following the mouse 1:1. */
const pointer = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
function stepPointer(dt: number): void {
  const stiffness = 40;
  const damping = 12;
  for (const axis of ["x", "y"] as const) {
    const v = axis === "x" ? "vx" : "vy";
    const target = axis === "x" ? pointer.tx : pointer.ty;
    pointer[v] += ((target - pointer[axis]) * stiffness - pointer[v] * damping) * dt;
    pointer[axis] += pointer[v] * dt;
  }
}

function mountShader(canvas: HTMLCanvasElement, fragment: string, scale: number): Scene | null {
  const section = canvas.closest<HTMLElement>("[data-shader-section]");
  const image = section?.querySelector<HTMLImageElement>("img[data-shader-image]");
  if (!section || !image) return null;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("u_res");
  const uImg = u("u_imgSize");
  const uTime = u("u_time");
  const uPointer = u("u_pointer");
  const uScroll = u("u_scroll");
  gl.uniform1i(u("u_img"), 0);
  gl.uniform2f(uImg, image.naturalWidth, image.naturalHeight);

  let shown = false;
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 1.5) * scale;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
  };
  resize();

  return {
    canvas,
    section,
    resize,
    draw(time: number) {
      const box = section.getBoundingClientRect();
      // 0 while the section's top is at the top of the viewport, 1 once it has scrolled out.
      const scroll = Math.min(1, Math.max(-1, -box.top / Math.max(1, box.height)));
      gl.uniform1f(uTime, time);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.uniform1f(uScroll, scroll);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!shown) {
        shown = true;
        canvas.classList.add("ready");
      }
    },
  };
}

function whenLoaded(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("image")), { once: true });
  });
}

function startShaders(): void {
  const specs: Array<[string, string, number]> = [
    ["canvas[data-shader='sky']", SKY, 1],
    ["canvas[data-shader='glass']", GLASS, 0.85],
  ];
  const scenes: Scene[] = [];
  const visible = new Set<Scene>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const scene = scenes.find((item) => item.section === entry.target);
      if (!scene) continue;
      if (entry.isIntersecting) visible.add(scene);
      else visible.delete(scene);
    }
    loop();
  });

  // Reduced motion: one frame, standing still.
  const STILL = 40;
  let frame = 0;
  let last = performance.now();
  const start = last - STILL * 1000;
  function loop(): void {
    if (visible.size === 0) return;
    if (reduceMotion.matches) {
      for (const scene of visible) scene.draw(STILL);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(function tick(now) {
      frame = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      stepPointer(dt);
      for (const scene of visible) scene.draw((now - start) / 1000);
      if (visible.size > 0 && !document.hidden) frame = requestAnimationFrame(tick);
    });
  }

  // Each shader starts on its own once its photograph is there; the night one loads lazily.
  for (const [selector, fragment, scale] of specs) {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    const image = canvas?.closest("[data-shader-section]")?.querySelector<HTMLImageElement>("img[data-shader-image]");
    if (!canvas || !image) continue;
    whenLoaded(image)
      .then(() => {
        const scene = mountShader(canvas, fragment, scale);
        if (!scene) return;
        scenes.push(scene);
        observer.observe(scene.section);
      })
      .catch(() => undefined);
  }

  addEventListener("resize", () => {
    for (const scene of scenes) scene.resize();
    if (reduceMotion.matches) for (const scene of visible) scene.draw(STILL);
  });
  addEventListener(
    "pointermove",
    (event) => {
      if (!finePointer.matches) return;
      pointer.tx = (event.clientX / innerWidth - 0.5) * 2;
      pointer.ty = -(event.clientY / innerHeight - 0.5) * 2;
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    last = performance.now();
    if (!document.hidden) loop();
  });
  reduceMotion.addEventListener("change", () => loop());
}

// ---------------------------------------------------------------- chats

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const played = new WeakSet<HTMLElement>();

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Shows one step and lets the thread slide up by exactly the height it added
 * (FLIP): the thread is anchored at the bottom, so whatever was there before
 * moves up while the new message rises in. WAAPI, so it stays off the main
 * thread's layout work.
 */
function reveal(thread: HTMLElement, step: HTMLElement, change: () => void): void {
  const before = thread.offsetHeight;
  change();
  const delta = thread.offsetHeight - before;
  if (delta > 0) thread.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 420, easing: EASE_OUT });
  const target = step.classList.contains("msg") ? step.querySelector<HTMLElement>(step.classList.contains("typing") ? ".dots" : ".bubble") : step;
  if (!target || step.classList.contains("tap")) return;
  const origin = step.classList.contains("me") ? "bottom right" : "bottom left";
  target.style.transformOrigin = origin;
  target.animate(
    [
      { opacity: 0, transform: "translateY(8px) scale(0.94)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 380, easing: EASE_OUT },
  );
}

/**
 * Plays one conversation: every element with `data-step` appears in order,
 * after its `data-wait`. Serain's messages show the typing dots first.
 * Already played conversations stay as they are.
 */
async function play(thread: HTMLElement): Promise<void> {
  if (played.has(thread)) return;
  played.add(thread);
  const steps = [...thread.querySelectorAll<HTMLElement>("[data-step]")].sort((a, b) => Number(a.dataset["step"]) - Number(b.dataset["step"]));
  if (reduceMotion.matches) {
    for (const step of steps) step.classList.add("on");
    return;
  }
  for (const step of steps) {
    await wait(Number(step.dataset["wait"] ?? "600"));
    if (step.classList.contains("them")) {
      reveal(thread, step, () => step.classList.add("typing"));
      await wait(Math.min(1400, 500 + (step.textContent?.length ?? 0) * 6));
      reveal(thread, step, () => {
        step.classList.remove("typing");
        step.classList.add("on");
      });
      continue;
    }
    reveal(thread, step, () => step.classList.add("on"));
  }
}

function startChats(): void {
  const hero = document.querySelector<HTMLElement>("[data-hero-thread]");
  if (hero) void wait(500).then(() => play(hero));

  // Every other conversation plays once it is in view: the sticky phone shows the active chapter's,
  // on narrow screens each chapter carries its own.
  const inView = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const thread = entry.target as HTMLElement;
        if (thread.closest(".phone-stack") && !thread.closest(".scene.active")) continue;
        void play(thread);
      }
    },
    { threshold: 0.6 },
  );
  for (const thread of document.querySelectorAll("[data-thread]")) inView.observe(thread);

  const phone = document.querySelector<HTMLElement>(".phone-stack");
  const chapters = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
  if (!phone || chapters.length === 0) return;
  const scenes = [...phone.querySelectorAll<HTMLElement>(".scene")];
  const activate = (index: number) => {
    for (const [i, scene] of scenes.entries()) scene.classList.toggle("active", i === index);
    for (const [i, chapter] of chapters.entries()) chapter.classList.toggle("active", i === index);
    const thread = scenes[index]?.querySelector<HTMLElement>("[data-thread]");
    if (thread && getComputedStyle(phone).display !== "none") void play(thread);
  };
  const chapterObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) activate(chapters.indexOf(entry.target as HTMLElement));
    },
    { rootMargin: "-48% 0px -48% 0px" },
  );
  for (const chapter of chapters) chapterObserver.observe(chapter);
}

// ---------------------------------------------------------------- nav

/** The nav turns into its glass pill as soon as the page has scrolled. */
function startNav(): void {
  const nav = document.querySelector<HTMLElement>("[data-nav]");
  if (!nav) return;
  let pending = false;
  const update = () => {
    pending = false;
    nav.classList.toggle("scrolled", scrollY > 8);
  };
  addEventListener(
    "scroll",
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

// ---------------------------------------------------------------- flow

/**
 * One message's round trip through the four boxes of "Yours, on your server",
 * on a loop: from the iPhone through Photon to the server, which looks
 * something up in Supabase and answers the same way back. Times are parts of
 * one cycle; packets ride their wire's lane (`.pkt`), boxes ring (`.ping`) as
 * one arrives, the server shows that it works in between.
 */
const FLOW_CYCLE = 7200;
const TRIPS: ReadonlyArray<{ wire: number; dir: 1 | -1; from: number; to: number }> = [
  { wire: 0, dir: 1, from: 0.03, to: 0.14 },
  { wire: 1, dir: 1, from: 0.17, to: 0.28 },
  { wire: 2, dir: 1, from: 0.34, to: 0.42 },
  { wire: 2, dir: -1, from: 0.46, to: 0.54 },
  { wire: 1, dir: -1, from: 0.6, to: 0.71 },
  { wire: 0, dir: -1, from: 0.74, to: 0.85 },
];
/** When a packet leaves or arrives at a box: iPhone, Photon, server, Supabase. */
const RINGS: ReadonlyArray<readonly number[]> = [[0.02, 0.85], [0.14, 0.71], [0.28, 0.54], [0.42]];
const WORK = { from: 0.29, to: 0.6 };
const SWAY = "cubic-bezier(0.45, 0, 0.55, 1)";

function startFlow(): void {
  const flow = document.querySelector<HTMLElement>("[data-flow]");
  if (!flow || reduceMotion.matches) return;
  const wide = matchMedia("(min-width: 900px)");
  let running: Animation[] = [];

  const build = () => {
    for (const animation of running) animation.cancel();
    const along = wide.matches ? "translateX(100%)" : "translateY(100%)";
    const options: KeyframeAnimationOptions = { duration: FLOW_CYCLE, iterations: Infinity };
    running = [];
    for (const trip of TRIPS) {
      const lane = flow.querySelector<HTMLElement>(`.pkt[data-wire="${trip.wire}"][data-dir="${trip.dir}"]`);
      if (!lane) continue;
      const [start, end] = trip.dir === 1 ? ["none", along] : [along, "none"];
      running.push(
        lane.animate(
          [
            { offset: 0, opacity: 0, transform: start },
            { offset: trip.from, opacity: 0, transform: start, easing: SWAY },
            { offset: trip.from + 0.015, opacity: 1 },
            { offset: trip.to - 0.015, opacity: 1 },
            { offset: trip.to, opacity: 0, transform: end },
            { offset: 1, opacity: 0, transform: end },
          ],
          options,
        ),
      );
    }
    for (const [index, times] of RINGS.entries()) {
      const ping = flow.querySelector<HTMLElement>(`[data-node="${index}"] .ping`);
      if (!ping) continue;
      const frames: Keyframe[] = [{ offset: 0, opacity: 0, transform: "scale(0.98)" }];
      // Dark until the moment, then a ring that widens and fades.
      for (const t of times) {
        frames.push(
          { offset: t - 0.01, opacity: 0, transform: "scale(0.98)" },
          { offset: t, opacity: 0.9, transform: "scale(0.98)", easing: EASE_OUT },
          { offset: t + 0.1, opacity: 0, transform: "scale(1.06)" },
        );
      }
      frames.push({ offset: 1, opacity: 0, transform: "scale(1.06)" });
      running.push(ping.animate(frames, options));
    }
    const work = flow.querySelector<HTMLElement>(".work");
    if (work) {
      running.push(
        work.animate(
          [
            { offset: 0, opacity: 0 },
            { offset: WORK.from, opacity: 0 },
            { offset: WORK.from + 0.02, opacity: 1 },
            { offset: WORK.to - 0.02, opacity: 1 },
            { offset: WORK.to, opacity: 0 },
            { offset: 1, opacity: 0 },
          ],
          options,
        ),
      );
    }
  };

  // Plays only while the boxes are on screen; the first round starts once they have arrived.
  let visible = false;
  const sync = () => {
    for (const animation of running) {
      if (visible && !document.hidden) animation.play();
      else animation.pause();
    }
  };
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible && running.length === 0) build();
    sync();
  }).observe(flow);
  wide.addEventListener("change", () => {
    if (running.length === 0) return;
    build();
    sync();
  });
  document.addEventListener("visibilitychange", sync);
}

// ---------------------------------------------------------------- reveals and copy

function startReveals(): void {
  const items = document.querySelectorAll(".reveal");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    for (const item of items) item.classList.add("in");
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  for (const item of items) observer.observe(item);
}

/**
 * The definition lights up word by word while it crosses the middle of the
 * screen: scroll position decides how many words are lit, a CSS transition on
 * opacity does the rest.
 */
function startWords(): void {
  for (const block of document.querySelectorAll<HTMLElement>("[data-words]")) {
    const words = [...block.querySelectorAll<HTMLElement>(".w")];
    if (reduceMotion.matches) {
      for (const word of words) word.classList.add("lit");
      continue;
    }
    block.classList.add("dim");
    let pending = false;
    const update = () => {
      pending = false;
      const box = block.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (innerHeight * 0.85 - box.top) / (innerHeight * 0.5)));
      const lit = Math.round(progress * words.length);
      for (const [index, word] of words.entries()) word.classList.toggle("lit", index < lit);
    };
    addEventListener(
      "scroll",
      () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }
}

function startCopy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.hidden = false;
    let timer = 0;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset["copy"] ?? "");
      } catch {
        return;
      }
      button.classList.add("copied");
      clearTimeout(timer);
      timer = window.setTimeout(() => button.classList.remove("copied"), 1600);
    });
  }
}

// ---------------------------------------------------------------- connector directory

/**
 * Search and category filter on /connectors. The page lists every connector
 * without script; this only hides tiles (`hidden`) that do not match, and a
 * group once none of its tiles is left.
 */
function startDirectory(): void {
  const root = document.querySelector<HTMLElement>("[data-directory]");
  if (!root) return;
  const input = root.querySelector<HTMLInputElement>("[data-search-input]");
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-filter]")];
  const tiles = [...root.querySelectorAll<HTMLElement>(".conn[data-search]")];
  const groups = [...root.querySelectorAll<HTMLElement>("[data-group]")];
  const none = root.querySelector<HTMLElement>("[data-no-match]");
  if (!input) return;
  for (const part of root.querySelectorAll<HTMLElement>("[data-filters]")) part.hidden = false;
  let category = "all";

  const apply = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const filtering = category !== "all" || words.length > 0;
    let shown = 0;
    for (const tile of tiles) {
      const text = tile.dataset["search"] ?? "";
      const match = (category === "all" || tile.dataset["category"] === category) && words.every((word) => text.includes(word));
      tile.hidden = !match;
      if (match) shown++;
    }
    // A group without tiles (the empty community) only shows while nothing is filtered.
    for (const group of groups) group.hidden = filtering && !group.querySelector(".conn:not([hidden])");
    if (none) none.hidden = shown > 0;
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      category = button.dataset["filter"] ?? "all";
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      apply();
    });
  }
  input.addEventListener("input", apply);
}

// ---------------------------------------------------------------- submit a connector

/**
 * The submit form as steps. Without script it is one form with a plain tools
 * field; here each step shows alone, Next checks the step's own fields, and
 * the tools are rows with a level picker that write the plain field. Rows are
 * cloned from a <template>, never built from HTML strings.
 */
function startWizard(): void {
  const form = document.querySelector<HTMLFormElement>("[data-wizard]");
  if (!form) return;
  const steps = [...form.querySelectorAll<HTMLFieldSetElement>("[data-step]")];
  const nav = [...document.querySelectorAll<HTMLButtonElement>("[data-goto]")];
  const prev = form.querySelector<HTMLButtonElement>("[data-prev]");
  const next = form.querySelector<HTMLButtonElement>("[data-next]");
  const progress = form.querySelector<HTMLElement>("[data-progress]");
  const rows = form.querySelector<HTMLElement>("[data-tool-rows]");
  const template = form.querySelector<HTMLTemplateElement>("[data-tool-template]");
  const add = form.querySelector<HTMLButtonElement>("[data-tool-add]");
  const raw = form.querySelector<HTMLTextAreaElement>('textarea[name="tools"]');
  const source = form.querySelector<HTMLInputElement>('input[name="source"]');
  const kinds = [...form.querySelectorAll<HTMLButtonElement>("[data-kind]")];
  if (!prev || !next || !progress || !rows || !template || !add || !raw || !source) return;

  // The script checks step by step; the browser's own check would stop silently at a field in a hidden step.
  form.noValidate = true;
  document.documentElement.classList.add("wizard-on");
  for (const part of document.querySelectorAll<HTMLElement>("[data-wizard-only]")) part.hidden = false;
  for (const part of form.querySelectorAll<HTMLElement>("[data-no-wizard]")) part.hidden = true;

  // Tools: rows ↔ the plain field, one line per tool.
  const sync = () => {
    raw.value = [...rows.querySelectorAll<HTMLElement>(".tool-row")]
      .map((row) => {
        const name = row.querySelector<HTMLInputElement>(".tool-name")!.value.trim();
        const label = row.querySelector<HTMLInputElement>(".tool-label")!.value.trim().replace(/\s*,\s*/g, " ");
        const level = row.querySelector<HTMLSelectElement>(".tool-level")!.value;
        return name ? `${name}, ${label}, ${level}` : "";
      })
      .filter(Boolean)
      .join("\n");
  };
  const addRow = (name = "", label = "", level = "read") => {
    const row = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    row.querySelector<HTMLInputElement>(".tool-name")!.value = name;
    row.querySelector<HTMLInputElement>(".tool-label")!.value = label;
    row.querySelector<HTMLSelectElement>(".tool-level")!.value = level === "write_reversible" ? level : "read";
    row.querySelector<HTMLButtonElement>(".tool-remove")!.addEventListener("click", () => {
      row.remove();
      if (!rows.querySelector(".tool-row")) addRow();
      sync();
    });
    rows.append(row);
    return row;
  };
  // A page restored from history keeps the plain field; its lines become rows again.
  const lines = raw.value.split("\n").map((line) => line.split(",").map((part) => part.trim())).filter(([name]) => name);
  for (const [name, label, level] of lines) addRow(name, label, level);
  if (!lines.length) addRow();
  rows.addEventListener("input", sync);
  rows.addEventListener("change", sync);
  add.addEventListener("click", () => {
    addRow().querySelector<HTMLInputElement>(".tool-name")!.focus();
  });

  // Built or idea: an idea needs no repository and no tools.
  let kind = "built";
  const setKind = (value: string) => {
    kind = value;
    for (const button of kinds) button.setAttribute("aria-pressed", String(button.dataset["kind"] === value));
    for (const part of form.querySelectorAll<HTMLElement>("[data-built-only]")) part.hidden = value !== "built";
    source.required = value === "built";
    if (value !== "built") source.value = "";
  };
  for (const button of kinds) button.addEventListener("click", () => setKind(button.dataset["kind"] ?? "built"));
  setKind(kind);

  let current = 0;
  let reached = 0;
  const review = () => {
    sync();
    for (const cell of form.querySelectorAll<HTMLElement>("[data-review-of]")) {
      const field = form.elements.namedItem(cell.dataset["reviewOf"] ?? "") as HTMLInputElement | HTMLTextAreaElement | null;
      const value = field?.value.trim() ?? "";
      cell.textContent = value || (cell.dataset["empty"] ?? "");
      cell.classList.toggle("is-empty", !value);
      cell.parentElement!.hidden = cell.dataset["reviewOf"] === "source" && kind !== "built";
    }
  };
  const show = (index: number, focus: boolean) => {
    current = Math.max(0, Math.min(steps.length - 1, index));
    reached = Math.max(reached, current);
    for (const [i, step] of steps.entries()) step.hidden = i !== current;
    for (const [i, button] of nav.entries()) {
      button.disabled = i > reached;
      if (i === current) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      button.classList.toggle("done", i < reached && i !== current);
    }
    prev.hidden = current === 0;
    next.hidden = current === steps.length - 1;
    progress.textContent = (progress.dataset["template"] ?? "").replace("{n}", String(current + 1)).replace("{total}", String(steps.length));
    if (current === steps.length - 1) review();
    if (focus) {
      steps[current]!.querySelector<HTMLElement>("legend")?.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
      steps[current]!.querySelector<HTMLElement>("input:not([type=hidden]), textarea, button")?.focus({ preventScroll: true });
    }
  };
  /** The fields of the step are valid; otherwise the browser shows why at the first one. */
  const valid = (index: number) => {
    const fields = [...steps[index]!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea, select")].filter((field) => !field.closest('[hidden]:not([data-step])'));
    const bad = fields.find((field) => !field.checkValidity());
    bad?.reportValidity();
    return !bad;
  };

  next.addEventListener("click", () => {
    if (valid(current)) show(current + 1, true);
  });
  prev.addEventListener("click", () => show(current - 1, true));
  for (const [index, button] of nav.entries()) button.addEventListener("click", () => show(index, true));
  form.addEventListener("submit", (event) => {
    sync();
    for (let i = 0; i < steps.length; i++) {
      if (!valid(i)) {
        event.preventDefault();
        show(i, false);
        valid(i);
        return;
      }
    }
  });
  show(0, false);
}

startNav();
startReveals();
startDirectory();
startWizard();
startWords();
startChats();
startFlow();
startCopy();
startShaders();
