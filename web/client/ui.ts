import { h, icon, type Child } from "./dom.js";

const TOAST_MS = 3200;

/**
 * Short feedback at the bottom center. The area is a live region, screen
 * readers read it out. While the tab is in the background the clock stops:
 * what the owner has not seen is not gone when they come back.
 */
export function toast(text: string): void {
  const region = document.getElementById("toasts")!;
  const el = h("div", { class: "toast" }, text);
  region.append(el);
  let left = TOAST_MS;
  let since = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const leave = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    el.classList.add("leaving");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  const run = () => {
    since = Date.now();
    timer = setTimeout(leave, left);
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      left -= Date.now() - since;
    } else run();
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) run();
}

/** A placeholder in the shape of what is about to come, instead of an empty white area. */
export function skeleton(rows = 6): HTMLElement {
  return h(
    "div",
    { class: "skeleton", "aria-busy": "true", "aria-label": "Loading" },
    ...Array.from({ length: rows }, (_, i) => {
      const bar = h("span", { class: "bar" });
      // Through CSSOM, not as a style attribute: the CSP allows no inline styles.
      bar.style.width = `${46 + ((i * 17) % 38)}%`;
      return h("div", { class: "skeleton-row" }, h("span", { class: "bar short" }), bar);
    }),
  );
}

export function empty(title: string, text?: string, action?: HTMLElement): HTMLElement {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), text ? h("p", { class: "empty-text" }, text) : null, action ?? null);
}

export function button(label: Child | Child[], props: Record<string, unknown> & { variant?: "primary" | "ghost" | "quiet" } = {}): HTMLButtonElement {
  const { variant = "ghost", class: extra, ...rest } = props;
  return h("button", { type: "button", class: `btn ${variant}${extra ? ` ${String(extra)}` : ""}`, ...rest }, ...(Array.isArray(label) ? label : [label]));
}

/** Puts a button into "running" for the duration of `run`: disabled, with its own text. Submitting twice is impossible that way. */
export async function busy<T>(target: HTMLButtonElement, label: string, run: () => Promise<T>): Promise<T> {
  const before = [...target.childNodes];
  target.disabled = true;
  target.setAttribute("aria-busy", "true");
  target.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), label);
  try {
    return await run();
  } finally {
    target.disabled = false;
    target.removeAttribute("aria-busy");
    target.replaceChildren(...before);
  }
}

/**
 * A modal dialog with the native <dialog>: focus stays inside, Esc closes,
 * afterwards focus returns to the trigger. A click outside deliberately does
 * not close it; in a half-filled form that would be an accident. It leaves the
 * way it came (`.closing`) and only closes after that.
 */
export function dialog(title: string, body: Child[], options: { onClose?: () => void; wide?: boolean } = {}): { el: HTMLDialogElement; close: () => void } {
  const trigger = document.activeElement as HTMLElement | null;
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const closeButton = h("button", { type: "button", class: "icon-btn dialog-x", "aria-label": "Close" }, icon("x"));
  const el = h("dialog", { class: `dialog${options.wide ? " wide" : ""}`, "aria-labelledby": id }, h("div", { class: "dialog-head" }, h("h2", { id }, title), closeButton), ...body);
  const close = () => {
    if (!el.open || el.classList.contains("closing")) return;
    el.classList.add("closing");
    // getAnimations reads the new style at once; without a transition (reduced motion) it closes right away.
    void Promise.all(el.getAnimations().map((animation) => animation.finished))
      .catch(() => undefined)
      .then(() => el.close());
  };
  closeButton.addEventListener("click", close);
  el.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  el.addEventListener("close", () => {
    el.remove();
    options.onClose?.();
    trigger?.focus?.();
  });
  document.body.append(el);
  el.showModal();
  return { el, close };
}

export function confirmDialog(options: { title: string; text: string; confirm: string; run: () => Promise<void> }): void {
  const ok = button(options.confirm, { variant: "primary" });
  const cancel = button("Cancel");
  const error = h("p", { class: "form-error", role: "alert" });
  const { close } = dialog(options.title, [h("p", { class: "dialog-text" }, options.text), h("div", { class: "dialog-foot" }, error, cancel, ok)]);
  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => {
    error.textContent = "";
    void busy(ok, "One moment …", options.run)
      .then(close)
      .catch((err: unknown) => {
        error.replaceChildren(icon("alert"), (err as Error).message);
      });
  });
  cancel.focus();
}

/*
 * Times in the browser's time zone and dates in the browser's locale: only the
 * owner sees the web interface, on their own devices. Texts the worker builds
 * (audit-format.ts) are in OWNER_TIMEZONE.
 */
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const weekdayYearFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
export const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const shortDateThisYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const relativeDay = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "Today", "Yesterday" in the browser's language, like the dates next to them. */
const relativeDayLabel = (days: number) => {
  const text = relativeDay.format(days, "day");
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
};

/** "2026-10-02" in local time, to group by day. */
export const dayKey = (date: Date) => dayKeyFmt.format(date);

/** "Today", "Yesterday", otherwise "Wednesday, 30 September"; the year only when it is not this one. */
export function dayLabel(date: Date, now = new Date()): string {
  const key = dayKey(date);
  if (key === dayKey(now)) return relativeDayLabel(0);
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return relativeDayLabel(-1);
  return (key.slice(0, 4) === dayKey(now).slice(0, 4) ? weekdayFmt : weekdayYearFmt).format(date);
}

export function compactDate(date: Date, now = new Date()): string {
  return (dayKey(date).slice(0, 4) === dayKey(now).slice(0, 4) ? shortDateThisYear : shortDate).format(date);
}
