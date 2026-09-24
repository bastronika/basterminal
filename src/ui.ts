// Small DOM helpers: element builder, modal dialogs and toasts.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "class") {
      el.className = String(v);
    } else if (k in el && typeof v !== "string") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

export interface Button {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

/** Shows a modal and resolves with the clicked button's value (null if dismissed). */
export function modal(title: string, body: Node, buttons: Button[] = [{ label: "OK", value: "ok", primary: true }]) {
  return new Promise<string | null>((resolve) => {
    const dlg = h("dialog", { class: "modal" });
    const close = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const footer = h(
      "div",
      { class: "modal-actions" },
      ...buttons.map((b) =>
        h(
          "button",
          {
            type: "button",
            class: b.primary ? "btn primary" : b.danger ? "btn danger" : "btn",
            onclick: () => close(b.value),
          },
          b.label,
        ),
      ),
    );
    const form = h("form", { method: "dialog", onsubmit: (e: Event) => {
      e.preventDefault();
      const primary = buttons.find((b) => b.primary);
      if (primary) close(primary.value);
    } }, h("h2", {}, title), h("div", { class: "modal-body" }, body), footer);
    dlg.append(form);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector<HTMLElement>("input, textarea, select");
    first?.focus();
  });
}

export async function confirmDialog(title: string, message: string, danger = false) {
  const res = await modal(title, h("p", {}, message), [
    { label: "Batal", value: "cancel" },
    { label: "Ya", value: "ok", primary: !danger, danger },
  ]);
  return res === "ok";
}

export async function promptDialog(title: string, label: string, value = "", type = "text") {
  const input = h("input", { type, value, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
  const res = await modal(title, h("label", { class: "field" }, label, input), [
    { label: "Batal", value: "cancel" },
    { label: "OK", value: "ok", primary: true },
  ]);
  return res === "ok" ? input.value : null;
}

export function field(label: string, input: HTMLElement, hint?: string) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

let toastTimer: number | undefined;
export function toast(message: string, kind: "info" | "error" | "ok" = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast" });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), kind === "error" ? 5000 : 2500);
}

export function errMsg(e: unknown) {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export function formatSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
