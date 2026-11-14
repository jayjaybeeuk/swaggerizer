/*
 * swaggerizer/debug-menu — a floating in-page menu for switching mock responses while you use your
 * app. Framework-free and rendered in a shadow root so it never clashes with the host page styles.
 *
 *   import { mountDebugMenu } from "swaggerizer/debug-menu";
 *   const mocks = createMocks();
 *   await setupWorker(...mocks.handlers).start();
 *   mountDebugMenu(mocks);
 */
import { variantsOf, type Variant } from "./scenario";
import type { OperationState } from "./types";
import type { SwaggerizerMocks } from "./msw";

export interface DebugMenuOptions {
  /** Corner to dock the launcher in (default "bottom-right"). */
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Keyboard shortcut that toggles the panel (default "Alt+Shift+S"; false disables). */
  shortcut?: string | false;
  /** Start with the panel open. */
  open?: boolean;
  /** Element to mount into (default document.body). */
  container?: HTMLElement;
  title?: string;
}

export interface DebugMenu {
  open: () => void;
  close: () => void;
  toggle: () => void;
  destroy: () => void;
}

const PROXY = "__proxy__";
const CUSTOM = "__custom__";

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { position: fixed; z-index: 2147483000; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #17202b; }
.root.br { right: 16px; bottom: 16px; } .root.bl { left: 16px; bottom: 16px; }
.root.tr { right: 16px; top: 16px; } .root.tl { left: 16px; top: 16px; }
.launcher { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 999px; padding: 8px 14px; background: #0f766e; color: #fff; font: 600 13px/1 inherit; font-family: inherit; cursor: pointer; box-shadow: 0 4px 14px rgba(15, 23, 42, .25); }
.launcher:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #5eead4; outline-offset: 2px; }
.count { background: #fff; color: #115e59; border-radius: 999px; padding: 2px 7px; font-size: 11px; }
.panel { position: absolute; width: min(440px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 90px)); display: flex; flex-direction: column; background: #fff; border: 1px solid #dfe3e8; border-radius: 12px; box-shadow: 0 12px 40px rgba(15, 23, 42, .28); overflow: hidden; }
.br .panel, .bl .panel { bottom: 48px; } .tr .panel, .tl .panel { top: 48px; }
.br .panel, .tr .panel { right: 0; } .bl .panel, .tl .panel { left: 0; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #dfe3e8; background: #f5f6f8; }
.head h2 { margin: 0; font-size: 14px; flex: 1; }
.src { font-size: 11px; color: #6b7685; }
.btn { white-space: nowrap; border: 1px solid #c7cdd5; background: #fff; color: #17202b; border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.btn:hover { background: #f0f2f5; }
.btn.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
.search { padding: 8px 12px; border-bottom: 1px solid #dfe3e8; }
.search input { width: 100%; padding: 6px 8px; border: 1px solid #c7cdd5; border-radius: 6px; font: inherit; }
.list { overflow: auto; padding: 4px 0 8px; }
.group { padding: 8px 12px 2px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6b7685; }
.op { padding: 8px 12px; border-top: 1px solid #f0f2f5; }
.op.mod { background: #e6f4f2; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.m { font: 700 10px/1 ui-monospace, Menlo, monospace; padding: 3px 5px; border-radius: 4px; color: #fff; background: #6b7685; text-transform: uppercase; flex: none; }
.m.get { background: #1d4ed8; } .m.post { background: #15803d; } .m.put { background: #a15c00; } .m.patch { background: #7e22ce; } .m.delete { background: #b42318; }
.route { font-family: ui-monospace, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.controls { display: flex; gap: 6px; margin-top: 6px; }
select { flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid #c7cdd5; border-radius: 6px; font: inherit; font-size: 12px; background: #fff; color: inherit; }
.delay { width: 76px; padding: 4px 6px; border: 1px solid #c7cdd5; border-radius: 6px; font: inherit; font-size: 12px; }
.custom { margin-top: 6px; display: grid; gap: 6px; }
.custom .row input { width: 80px; padding: 4px 6px; border: 1px solid #c7cdd5; border-radius: 6px; font: inherit; font-size: 12px; }
textarea { width: 100%; min-height: 90px; padding: 6px; border: 1px solid #c7cdd5; border-radius: 6px; font: 12px/1.4 ui-monospace, Menlo, monospace; resize: vertical; }
.err { color: #b42318; font-size: 12px; }
.empty { padding: 16px 12px; color: #6b7685; }
@media (prefers-color-scheme: dark) {
  .root { color: #e6edf3; }
  .panel { background: #151b23; border-color: #2a323d; }
  .head { background: #1c232d; border-color: #2a323d; }
  .search, .op { border-color: #2a323d; }
  .op.mod { background: #0f2a28; }
  .btn, select, .delay, .search input, textarea, .custom .row input { background: #0d1117; color: #e6edf3; border-color: #3a4350; }
  .btn:hover { background: #1c232d; }
  .btn.primary { background: #2dd4bf; border-color: #2dd4bf; color: #0d1117; }
  .src, .group, .empty { color: #8b949e; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Array<Node | string | null | false | undefined>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value" || key === "selected" || key === "checked") (node as any)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function variantLabel(v: Variant): string {
  const name = v.kind === "generated" ? "generated" : v.kind === "empty" ? "no body" : v.example;
  return `${v.code} · ${name}`;
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+").map(p => p.trim());
  const key = parts[parts.length - 1];
  return (
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift") &&
    (event.ctrlKey || false) === parts.includes("ctrl") &&
    (event.metaKey || false) === (parts.includes("meta") || parts.includes("cmd")) &&
    (event.key.toLowerCase() === key || event.code.toLowerCase() === `key${key}`)
  );
}

export function mountDebugMenu(mocks: SwaggerizerMocks, options: DebugMenuOptions = {}): DebugMenu {
  if (typeof document === "undefined") throw new Error("mountDebugMenu needs a browser document.");
  const host = el("div", { "data-swaggerizer-debug-menu": "" });
  const shadow = host.attachShadow({ mode: "open" });
  const corner = { "bottom-right": "br", "bottom-left": "bl", "top-right": "tr", "top-left": "tl" }[options.position ?? "bottom-right"];
  const root = el("div", { class: `root ${corner}` });
  shadow.append(el("style", { text: STYLE }), root);
  (options.container ?? document.body).append(host);

  let isOpen = Boolean(options.open);
  let filter = "";
  const editing = new Map<string, { status: string; body: string; error?: string }>();
  const errors = new Map<string, string>();

  const run = (key: string, work: Promise<unknown>) => {
    work.then(() => errors.delete(key), err => errors.set(key, err?.message ?? String(err))).then(render);
  };

  function opRow(op: OperationState): HTMLElement {
    const variants = variantsOf(op);
    const current = op.mode === "proxy" ? PROXY : op.mode === "custom" ? CUSTOM : `${op.selectedCode}\u0000${op.selectedExample}`;
    const select = el("select", {
      "aria-label": `Response for ${op.method.toUpperCase()} ${op.route}`,
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value;
        if (value === PROXY) return run(op.key, mocks.select({ method: op.method, route: op.route, mode: "proxy" }));
        if (value === CUSTOM) return run(op.key, mocks.select({ method: op.method, route: op.route, mode: "custom" }));
        const [code, example] = value.split("\u0000");
        run(op.key, mocks.select({ method: op.method, route: op.route, code, example, mode: "mock" }));
      }
    },
      ...variants.map(v => el("option", { value: `${v.code}\u0000${v.example}`, selected: current === `${v.code}\u0000${v.example}`, text: variantLabel(v) })),
      el("option", { value: CUSTOM, selected: current === CUSTOM, text: "Custom response…" }),
      el("option", { value: PROXY, selected: current === PROXY, text: "Real API (passthrough)" })
    );

    const delay = el("input", {
      class: "delay",
      type: "number",
      min: "0",
      step: "100",
      placeholder: "delay ms",
      title: "Artificial latency in milliseconds",
      "aria-label": `Delay for ${op.method.toUpperCase()} ${op.route}`,
      value: op.delay ? String(op.delay) : "",
      onchange: (e: Event) => run(op.key, mocks.select({ method: op.method, route: op.route, delay: Number((e.target as HTMLInputElement).value) || 0 }))
    });

    let custom: HTMLElement | null = null;
    if (op.mode === "custom") {
      const draft = editing.get(op.key) ?? {
        status: String(op.custom?.status ?? 200),
        body: op.custom?.body === undefined ? "" : JSON.stringify(op.custom.body, null, 2)
      };
      const status = el("input", { type: "number", min: "100", max: "599", value: draft.status, "aria-label": "Status", oninput: (e: Event) => editing.set(op.key, { ...draft, status: (e.target as HTMLInputElement).value }) });
      const body = el("textarea", { spellcheck: "false", "aria-label": "Response body (JSON)", oninput: (e: Event) => { draft.body = (e.target as HTMLTextAreaElement).value; editing.set(op.key, draft); } });
      body.value = draft.body;
      custom = el("div", { class: "custom" },
        el("div", { class: "row" }, el("span", { text: "Status" }), status,
          el("button", {
            class: "btn primary",
            type: "button",
            text: "Apply",
            onclick: () => {
              editing.delete(op.key);
              run(op.key, mocks.select({ method: op.method, route: op.route, mode: "custom", custom: { status: Number(status.value), body: body.value } }));
            }
          })),
        body
      );
    }

    return el("div", { class: `op${op.modified ? " mod" : ""}` },
      el("div", { class: "row" },
        el("span", { class: `m ${op.method}`, text: op.method }),
        el("span", { class: "route", title: op.summary || op.route, text: op.route }),
        op.modified ? el("button", { class: "btn", type: "button", text: "Reset", onclick: () => run(op.key, mocks.reset({ method: op.method, route: op.route })) }) : null
      ),
      el("div", { class: "controls" }, select, delay),
      custom,
      errors.has(op.key) ? el("div", { class: "err", role: "alert", text: errors.get(op.key)! }) : null
    );
  }

  function render() {
    const active = shadow.activeElement as HTMLElement | null;
    // Don't rebuild under the user's cursor while they type in the custom-response editor.
    if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.getAttribute("type") === "number"))) return;
    const scroll = (shadow.querySelector(".list") as HTMLElement | null)?.scrollTop ?? 0;
    const ops = mocks.operations().filter(o => o.active);
    const switched = ops.filter(o => o.modified).length;

    const launcher = el("button", {
      class: "launcher",
      type: "button",
      "aria-expanded": String(isOpen),
      title: options.shortcut === false ? "Swaggerizer mocks" : `Swaggerizer mocks (${options.shortcut ?? "Alt+Shift+S"})`,
      onclick: () => toggle()
    }, "API mocks", switched ? el("span", { class: "count", text: String(switched) }) : null);

    const children: Node[] = [launcher];
    if (isOpen) {
      const q = filter.trim().toLowerCase();
      const visible = ops.filter(o => !q || `${o.method} ${o.route} ${o.summary ?? ""} ${o.operationId ?? ""} ${o.tags.join(" ")}`.toLowerCase().includes(q));
      const titles = new Map(mocks.manifests.map(m => [m.specId, m.title || m.specId]));
      const list = el("div", { class: "list" });
      let lastSpec = "";
      for (const op of visible) {
        if (op.specId !== lastSpec && mocks.manifests.length > 1) {
          list.append(el("div", { class: "group", text: titles.get(op.specId) ?? op.specId }));
        }
        lastSpec = op.specId;
        list.append(opRow(op));
      }
      if (visible.length === 0) list.append(el("div", { class: "empty", text: ops.length ? "No operations match." : "No operations in the manifests." }));

      const search = el("input", { type: "search", placeholder: "Filter operations…", value: filter, "aria-label": "Filter operations" });
      search.addEventListener("input", () => {
        filter = search.value;
        render();
        (shadow.querySelector(".search input") as HTMLInputElement | null)?.focus();
      });

      children.push(el("div", { class: "panel", role: "dialog", "aria-label": options.title ?? "Swaggerizer mocks" },
        el("div", { class: "head" },
          el("h2", { text: options.title ?? "Swaggerizer" }),
          el("span", { class: "src", title: mocks.server ? `Choices are shared with ${mocks.server}` : "Choices are stored in this browser", text: mocks.server ? "synced" : "local" }),
          el("button", { class: "btn", type: "button", text: "Reset all", onclick: () => run("*", mocks.reset()) }),
          el("button", { class: "btn", type: "button", "aria-label": "Close", text: "✕", onclick: () => close() })
        ),
        el("div", { class: "search" }, search),
        list
      ));
      requestAnimationFrame(() => {
        const l = shadow.querySelector(".list") as HTMLElement | null;
        if (l) l.scrollTop = scroll;
      });
    }
    root.replaceChildren(...children);
  }

  function open() { isOpen = true; render(); }
  function close() { isOpen = false; render(); }
  function toggle() { isOpen = !isOpen; render(); }

  const onKey = (event: KeyboardEvent) => {
    if (options.shortcut !== false && matchesShortcut(event, options.shortcut ?? "Alt+Shift+S")) {
      event.preventDefault();
      toggle();
    }
  };
  document.addEventListener("keydown", onKey);
  const unsubscribe = mocks.subscribe(render);
  const timer = mocks.server ? setInterval(() => { if (isOpen && !document.hidden) void mocks.sync(); }, 2000) : undefined;
  render();

  return {
    open,
    close,
    toggle,
    destroy() {
      document.removeEventListener("keydown", onKey);
      unsubscribe();
      if (timer) clearInterval(timer);
      host.remove();
    }
  };
}
