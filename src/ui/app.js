/* swaggerizer admin page – plain browser JavaScript, no build step or dependencies. */
(function () {
  "use strict";

  var metaContent = (document.querySelector('meta[name="swaggerizer-base"]') || {}).content;
  var BASE = (typeof metaContent === "string" && metaContent !== "__SWAGGERIZER_BASE__") ? metaContent : "/swaggerizer";
  var STATE_POLL_MS = 3000;
  var LOG_POLL_MS = 1500;
  var LOG_KEEP = 100;

  var ui = {
    data: null,
    dataSig: "",
    filterText: "",
    filterMethods: new Set(),
    onlyModified: false,
    openDrawers: new Set(),
    tryUrls: new Map(),
    tryResults: new Map(),
    drafts: new Map(),
    reportOpen: new Map(),
    logSince: 0,
    logEntries: [],
    logClearedAt: 0,
    freshLogIds: new Set()
  };

  var el = {
    stats: document.getElementById("stats"),
    conn: document.getElementById("conn"),
    specs: document.getElementById("spec-list"),
    methods: document.getElementById("method-filters"),
    filterText: document.getElementById("filter-text"),
    filterModified: document.getElementById("filter-modified"),
    content: document.getElementById("content"),
    log: document.getElementById("log"),
    logEmpty: document.getElementById("log-empty"),
    toasts: document.getElementById("toasts"),
    reload: document.getElementById("reload-btn"),
    resetAll: document.getElementById("reset-all-btn"),
    clearLog: document.getElementById("clear-log-btn")
  };

  /* ------------------------------------------------------------ helpers */

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
        else if (key === "checked" || key === "value" || key === "hidden" || key === "open") node[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(node, c); });
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  function api(path, body) {
    var opts = body === undefined
      ? { headers: { Accept: "application/json" } }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body)
        };
    return fetch(BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        setOnline(true);
        if (!res.ok) throw new Error(json.error || "Request failed (" + res.status + ")");
        return json;
      });
    }, function (err) {
      setOnline(false);
      throw err;
    });
  }

  function setOnline(online) {
    el.conn.classList.toggle("is-online", online);
    el.conn.classList.toggle("is-offline", !online);
    el.conn.querySelector(".conn-text").textContent = online ? "Live" : "Server unreachable";
  }

  function toast(message, isError) {
    var node = h("div", { class: "toast" + (isError ? " is-error" : ""), text: message });
    el.toasts.appendChild(node);
    setTimeout(function () { node.remove(); }, isError ? 6000 : 2600);
  }

  function statusClass(code) {
    var first = String(code).charAt(0);
    return "status status-" + ("12345".indexOf(first) >= 0 ? first : "5");
  }

  function methodBadge(method) {
    var m = String(method).toLowerCase();
    return h("span", { class: "method method-" + m, text: m.toUpperCase() });
  }

  function pretty(value) {
    if (value === undefined) return "(no body)";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
  }

  function timeOf(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function safeId(text) {
    return String(text).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function opId(op) {
    return "op-" + safeId(op.specId) + "-" + safeId(op.key);
  }

  /** Every selectable (code, example) pair for an operation – mirrors variantsOf() on the server. */
  function variantsOf(op) {
    var list = [];
    op.responses.forEach(function (r) {
      if (r.examples.length > 0) {
        r.examples.forEach(function (ex) {
          list.push({ code: r.code, example: ex.name, label: ex.name, summary: ex.summary, kind: "example", value: ex.value, response: r });
        });
      } else if (r.hasBody) {
        list.push({ code: r.code, example: "generated", label: "generated", kind: "generated", value: r.generated, response: r });
      } else {
        list.push({ code: r.code, example: "empty", label: "no body", kind: "empty", value: undefined, response: r });
      }
    });
    return list;
  }

  function selectedVariant(op, variants) {
    variants = variants || variantsOf(op);
    for (var i = 0; i < variants.length; i++) {
      if (variants[i].code === op.selectedCode && variants[i].example === op.selectedExample) return variants[i];
    }
    return null;
  }

  function sampleUrl(op) {
    return op.route.replace(/\{[^}]+\}/g, "1");
  }

  function specOf(op) {
    if (!ui.data) return null;
    for (var i = 0; i < ui.data.specs.length; i++) if (ui.data.specs[i].id === op.specId) return ui.data.specs[i];
    return null;
  }

  function servingLabel(op, current) {
    if (op.mode === "proxy") return "real API";
    if (op.mode === "custom") return (op.custom ? op.custom.status : "") + " · custom";
    return current ? current.code + " · " + current.label : op.selectedCode;
  }

  /* ------------------------------------------------------------ data flow */

  function applyState(state) {
    var sig = JSON.stringify(state);
    if (sig === ui.dataSig) return;
    ui.data = state;
    ui.dataSig = sig;
    render();
  }

  function refreshState() {
    return api("/api/state").then(applyState);
  }

  function mergeOperations(updated) {
    if (!ui.data) return;
    updated.forEach(function (op) {
      ui.data.operations = ui.data.operations.map(function (existing) {
        return existing.key === op.key && existing.specId === op.specId ? op : existing;
      });
    });
    ui.dataSig = "";
    render();
    refreshState().catch(function () {});
  }

  function select(op, body, message) {
    body.method = op.method;
    body.route = op.route;
    return api("/api/select", body)
      .then(function (res) {
        mergeOperations(res.operations || []);
        if (message) toast(op.method.toUpperCase() + " " + op.route + " → " + message);
      })
      .catch(function (err) {
        toast(err.message, true);
        refreshState().catch(function () {});
        throw err;
      });
  }

  function resetOne(op) {
    ui.drafts.delete(opId(op));
    return api("/api/reset", { method: op.method, route: op.route }).then(function (res) {
      applyState(res.state);
      toast(op.method.toUpperCase() + " " + op.route + " reset to default");
    }, function (err) { toast(err.message, true); });
  }

  function withBusy(button, work) {
    button.disabled = true;
    return work().then(function () { button.disabled = false; }, function () { button.disabled = false; });
  }

  /* ------------------------------------------------------------ rendering */

  function isEditing() {
    var a = document.activeElement;
    return a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.closest && a.closest(".op")));
  }

  function render() {
    if (!ui.data) return;
    var focusedId = document.activeElement && document.activeElement.id;
    renderStats();
    renderSpecs();
    renderMethodChips();
    // Polling must not wipe out what someone is typing into a custom response or delay box.
    if (isEditing()) ui.pendingOps = true;
    else {
      ui.pendingOps = false;
      renderOperations();
    }
    if (focusedId) {
      var again = document.getElementById(focusedId);
      if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }
  }

  function renderStats() {
    var specs = ui.data.specs;
    var ops = ui.data.operations;
    var enabled = specs.filter(function (s) { return s.enabled && !s.error; }).length;
    var active = ops.filter(function (o) { return o.active; });
    var changed = active.filter(function (o) { return o.modified; }).length;
    var breaking = (ui.data.changes || []).reduce(function (n, r) { return n + r.counts.breaking; }, 0);
    el.stats.replaceChildren(
      h("span", null, h("strong", { text: String(enabled) }), " / " + specs.length + " specs on"),
      h("span", null, h("strong", { text: String(active.length) }), " endpoints served"),
      h("span", null, h("strong", { text: String(changed) }), " switched"),
      breaking ? h("span", { class: "status-5" }, h("strong", { text: String(breaking) }), " breaking change" + (breaking === 1 ? "" : "s")) : null
    );
  }

  function renderSpecs() {
    var nodes = ui.data.specs.map(function (spec) {
      var id = "spec-toggle-" + safeId(spec.id);
      var meta = [];
      if (spec.specVersion) meta.push(h("span", { class: "badge badge-accent", text: (spec.specVersion === "2.0" ? "Swagger " : "OpenAPI ") + spec.specVersion }));
      if (spec.version) meta.push(h("span", { class: "badge", text: "v" + spec.version }));
      meta.push(h("span", { class: "badge", text: spec.operationCount + " op" + (spec.operationCount === 1 ? "" : "s") }));
      if (spec.warnings && spec.warnings.length) {
        meta.push(h("span", { class: "badge badge-warn", title: spec.warnings.join("\n"), text: spec.warnings.length + " warning" + (spec.warnings.length === 1 ? "" : "s") }));
      }

      return h("li", { class: "spec" + (spec.enabled ? "" : " is-off") },
        h("span", { class: "switch" },
          h("input", {
            type: "checkbox",
            role: "switch",
            id: id,
            checked: spec.enabled,
            "aria-label": (spec.enabled ? "Disable " : "Enable ") + spec.name,
            onchange: function (e) {
              var input = e.target;
              input.disabled = true;
              api("/api/spec", { id: spec.id, enabled: input.checked }).then(function (res) {
                applyState(res.state);
                toast(spec.name + (res.spec.enabled ? " enabled" : " disabled"));
              }, function (err) {
                toast(err.message, true);
                input.checked = !input.checked;
              }).then(function () { input.disabled = false; });
            }
          }),
          h("span", { class: "switch-track", "aria-hidden": "true" })
        ),
        h("div", { class: "spec-body" },
          h("label", { class: "spec-title", for: id, text: spec.title || spec.name }),
          h("div", { class: "spec-file", title: spec.file, text: spec.name }),
          h("div", { class: "spec-meta" }, meta),
          spec.error ? h("div", { class: "spec-error", text: "Failed to load: " + spec.error }) : null,
          spec.enabled && spec.operationCount > 0
            ? h("div", { class: "spec-jump" },
                h("button", {
                  type: "button",
                  class: "link-btn",
                  text: "Jump to endpoints",
                  onclick: function () {
                    var target = document.getElementById("group-" + safeId(spec.id));
                    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }),
                " · ",
                h("a", { class: "link-btn", href: BASE + "/api/openapi/" + encodeURIComponent(spec.id) + ".json", target: "_blank", rel: "noopener", text: "OpenAPI JSON" }))
            : null
        )
      );
    });
    if (nodes.length === 0) {
      nodes = [h("li", { class: "group-note", text: "No OpenAPI or Swagger files found." })];
    }
    el.specs.replaceChildren.apply(el.specs, nodes);
  }

  function renderMethodChips() {
    var methods = Array.from(new Set(ui.data.operations.map(function (o) { return o.method; }))).sort();
    el.methods.replaceChildren.apply(el.methods, methods.map(function (m) {
      return h("button", {
        type: "button",
        class: "chip",
        id: "chip-" + m,
        "aria-pressed": ui.filterMethods.has(m) ? "true" : "false",
        text: m,
        onclick: function () {
          if (ui.filterMethods.has(m)) ui.filterMethods.delete(m); else ui.filterMethods.add(m);
          render();
        }
      });
    }));
  }

  function matchesFilters(op) {
    if (ui.onlyModified && !op.modified) return false;
    if (ui.filterMethods.size && !ui.filterMethods.has(op.method)) return false;
    var q = ui.filterText.trim().toLowerCase();
    if (!q) return true;
    var haystack = [op.method, op.route, op.summary || "", op.description || "", op.operationId || "", op.specId, op.tags.join(" ")]
      .concat(variantsOf(op).map(function (v) { return v.code + " " + v.label; }))
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(q) >= 0;
  }

  function renderChanges() {
    var reports = (ui.data.changes || []).filter(function (r) { return r.changes.length; });
    if (!reports.length) return null;
    var breaking = reports.reduce(function (n, r) { return n + r.counts.breaking; }, 0);
    var snapshot = reports.some(function (r) { return r.baseline === "snapshot"; });
    return h("section", { class: "changes" + (breaking ? " is-breaking" : ""), "aria-label": "Contract changes" },
      h("h2", { text: breaking ? "Breaking contract changes detected" : "Contract changes detected" }),
      h("p", {
        class: "changes-sub",
        text: snapshot
          ? "The specs no longer match the generated client. Review these before running `swaggerizer generate`."
          : "The specs changed since they were last loaded."
      }),
      reports.map(function (report) {
        var title = (report.title || report.specId) +
          (report.fromVersion && report.toVersion && report.fromVersion !== report.toVersion ? " (" + report.fromVersion + " → " + report.toVersion + ")" : "") +
          " — " + report.counts.breaking + " breaking, " + report.counts.warning + " warning, " + report.counts.info + " info · " +
          report.added.length + " new, " + report.removed.length + " removed, " + report.changed.length + " changed" +
          (report.baseline === "snapshot" ? " (vs generated code)" : " (since last load)");
        var reportKey = report.specId + ":" + report.baseline;
        var isOpen = ui.reportOpen.has(reportKey) ? ui.reportOpen.get(reportKey) : report.counts.breaking > 0;
        return h("details", {
          class: "change-report",
          open: isOpen,
          ontoggle: function (e) { ui.reportOpen.set(reportKey, e.target.open); }
        },
          h("summary", { text: title }),
          h("ul", { class: "change-list" }, report.changes.map(function (c) {
            return h("li", null,
              h("span", { class: "sev sev-" + c.severity, text: c.severity }),
              h("span", { class: "change-op", text: c.operation }),
              h("span", { text: c.message }),
              c.location ? h("span", { class: "change-loc", text: c.location }) : null
            );
          }))
        );
      })
    );
  }

  function renderOperations() {
    var groups = [];
    var shown = 0;
    var changes = renderChanges();
    if (changes) groups.push(changes);

    ui.data.specs.forEach(function (spec) {
      var groupId = "group-" + safeId(spec.id);
      var ops = ui.data.operations.filter(function (o) { return o.specId === spec.id; });
      var visible = ops.filter(matchesFilters);
      var body;

      if (spec.error && ops.length === 0) {
        body = h("div", { class: "group-note", text: "This file could not be parsed: " + spec.error });
      } else if (!spec.enabled) {
        body = h("div", { class: "group-note", text: "Disabled – its " + ops.length + " endpoint" + (ops.length === 1 ? " is" : "s are") + " not being served. Switch it on in the Specs panel." });
      } else if (visible.length === 0) {
        if (ops.length > 0) return;
        body = h("div", { class: "group-note", text: "No operations are declared in this spec." });
      } else {
        shown += visible.length;
        body = h("div", { class: "group-body" }, visible.map(renderOperation));
      }

      groups.push(h("section", { class: "group", id: groupId, "aria-labelledby": groupId + "-title" },
        h("div", { class: "group-head" },
          h("h2", { id: groupId + "-title", text: spec.title || spec.name }),
          h("span", { class: "group-file", text: spec.name + (spec.basePaths.length ? " · " + spec.basePaths.join(", ") : "") })
        ),
        body
      ));
    });

    if (ui.data.specs.length === 0 || (shown === 0 && (ui.filterText || ui.filterMethods.size || ui.onlyModified))) {
      groups.push(h("div", { class: "empty", text: ui.data.specs.length ? "No endpoints match the current filter." : "No specs loaded." }));
    }
    el.content.replaceChildren.apply(el.content, groups);
  }

  function modeButtons(op, id) {
    var modes = [["mock", "Spec response"], ["custom", "Custom"], ["proxy", "Real API"]];
    return h("div", { class: "modes", role: "group", "aria-label": "How to answer" }, modes.map(function (m) {
      return h("button", {
        type: "button",
        id: id + "-mode-" + m[0],
        "aria-pressed": op.mode === m[0] ? "true" : "false",
        text: m[1],
        onclick: function () {
          if (op.mode === m[0]) return;
          select(op, { mode: m[0] }, m[1].toLowerCase()).catch(function () {});
        }
      });
    }));
  }

  function customEditor(op, id) {
    var draft = ui.drafts.get(id) || {
      status: String(op.custom ? op.custom.status : 200),
      contentType: (op.custom && op.custom.contentType) || "",
      body: op.custom && op.custom.body !== undefined ? pretty(op.custom.body) : ""
    };
    function keep(field) {
      return function (e) { draft[field] = e.target.value; ui.drafts.set(id, draft); };
    }
    return h("form", {
      class: "custom-editor",
      onsubmit: function (e) {
        e.preventDefault();
        var notJson = false;
        if (draft.body.trim() && (!draft.contentType || /json/i.test(draft.contentType))) {
          try { JSON.parse(draft.body); } catch (err) { notJson = true; }
        }
        if (notJson && draft.contentType) {
          toast("The body is not valid JSON – fix it or change the content type", true);
          return;
        }
        if (notJson) toast("The body is not valid JSON, so it will be sent as text/plain", true);
        select(op, { mode: "custom", custom: { status: Number(draft.status), body: draft.body, contentType: draft.contentType || undefined } }, "custom " + draft.status)
          .then(function () { ui.drafts.delete(id); render(); }, function () {});
      }
    },
      h("div", { class: "custom-row" },
        h("label", null, "Status", h("input", { type: "number", min: "100", max: "599", id: id + "-status", value: draft.status, oninput: keep("status") })),
        h("label", null, "Content type", h("input", { type: "text", id: id + "-ctype", placeholder: "application/json", value: draft.contentType, oninput: keep("contentType") })),
        h("button", { type: "submit", class: "btn btn-small", text: "Apply" })
      ),
      h("label", { class: "sr-only", for: id + "-body", text: "Response body" }),
      h("textarea", { id: id + "-body", spellcheck: "false", value: draft.body, placeholder: "{ \"message\": \"Anything you like\" }", oninput: keep("body") })
    );
  }

  function renderOperation(op) {
    var id = opId(op);
    var variants = variantsOf(op);
    var current = selectedVariant(op, variants);
    var drawerOpen = ui.openDrawers.has(id);
    var spec = specOf(op);

    var tags = [];
    if (op.modified) tags.push(h("span", { class: "badge badge-accent", text: "switched" }));
    if (op.deprecated) tags.push(h("span", { class: "badge badge-warn badge-deprecated", text: "deprecated" }));
    if (op.shadowedBy) tags.push(h("span", { class: "badge badge-warn", title: "Another enabled spec already serves this method and route", text: "shadowed by " + op.shadowedBy }));

    var meta = [];
    if (op.operationId) meta.push(h("span", { class: "badge", title: "operationId – the generated client function name", text: op.operationId }));
    op.tags.forEach(function (t) { meta.push(h("span", { class: "badge", text: "#" + t })); });

    var body;
    if (op.mode === "custom") {
      body = customEditor(op, id);
    } else if (op.mode === "proxy") {
      body = h("p", { class: "proxy-note" }, "Requests are forwarded to ",
        h("code", { text: spec && spec.proxyTarget ? spec.proxyTarget : "(no upstream – start with --proxy <url>)" }),
        ". In the browser, MSW lets them through to the real API.");
    } else {
      body = variants.length
        ? h("fieldset", { class: "variants" },
            h("legend", { text: "Response" }),
            variants.map(function (v, i) {
              var inputId = id + "-v" + i;
              var isDefault = v.code === op.defaultCode && v.example === op.defaultExample;
              return h("label", { class: "variant", for: inputId, title: v.summary || v.response.description || "" },
                h("input", {
                  type: "radio",
                  id: inputId,
                  name: id + "-variant",
                  checked: current === v,
                  onchange: function () { select(op, { code: v.code, example: v.example, mode: "mock" }, v.code + " · " + v.label).catch(function () {}); }
                }),
                h("span", { class: statusClass(v.code), text: v.code }),
                h("span", { class: "variant-name", text: v.label }),
                isDefault ? h("span", { class: "variant-default", text: "default" }) : null
              );
            })
          )
        : h("p", { class: "op-desc", text: "This operation declares no responses; swaggerizer answers 200 with an empty object." });
    }

    var selection = op.mode === "custom"
      ? { method: op.method, route: op.route, mode: "custom" }
      : op.mode === "proxy"
        ? { method: op.method, route: op.route, mode: "proxy" }
        : { method: op.method, route: op.route, code: op.selectedCode, example: op.selectedExample };
    if (op.delay) selection.delay = op.delay;
    var link = location.origin + BASE + "/api/select?" + new URLSearchParams(selection).toString();
    var curl = "curl -s -X POST " + shellQuote(location.origin + BASE + "/api/select") +
      " -H 'Content-Type: application/json' -d " +
      shellQuote(JSON.stringify(op.mode === "custom" ? Object.assign({}, selection, { custom: op.custom }) : selection));

    var tryUrl = ui.tryUrls.has(id) ? ui.tryUrls.get(id) : sampleUrl(op);
    var tryResult = ui.tryResults.get(id);
    var preview = op.mode === "custom" ? (op.custom ? op.custom.body : undefined) : current ? current.value : undefined;
    var previewStatus = op.mode === "custom" ? (op.custom ? String(op.custom.status) : "") : current ? current.code : "";

    var drawer = h("div", { class: "drawer", id: id + "-drawer", hidden: !drawerOpen },
      h("div", null,
        h("div", { class: "drawer-label" }, "Will respond with",
          op.mode === "proxy" ? h("span", { class: "badge", text: "real API" }) : h("span", { class: statusClass(previewStatus), text: previewStatus }),
          op.mode === "mock" && current && current.response.contentTypes.length ? h("span", { class: "badge", text: current.response.contentTypes[0] }) : null,
          op.mode === "mock" && current && current.kind === "generated" ? h("span", { class: "badge", title: "No example in the spec – synthesised from the schema. MSW mocks use orval's faker data instead.", text: "synthesised" }) : null
        ),
        h("pre", { class: "code", text: op.mode === "proxy" ? "(whatever the real API returns)" : pretty(preview) })
      ),
      h("div", null,
        h("div", { class: "drawer-label", text: "Try it against the mock" }),
        h("form", {
          class: "try-row",
          onsubmit: function (e) {
            e.preventDefault();
            sendTry(op, id);
          }
        },
          h("label", { class: "sr-only", for: id + "-url", text: "Request path" }),
          h("input", {
            id: id + "-url",
            value: tryUrl,
            spellcheck: "false",
            oninput: function (e) { ui.tryUrls.set(id, e.target.value); }
          }),
          h("button", { type: "submit", class: "btn btn-small", text: "Send " + op.method.toUpperCase() })
        ),
        tryResult ? h("div", { class: "try-result" },
          h("div", { class: "try-meta" },
            tryResult.error ? h("span", { class: "status status-5", text: "Network error" }) : h("span", { class: statusClass(tryResult.status), text: String(tryResult.status) }),
            h("span", { text: tryResult.ms + " ms" }),
            tryResult.type ? h("span", { text: tryResult.type }) : null
          ),
          h("pre", { class: "code", text: tryResult.error || tryResult.body || "(empty body)" })
        ) : null
      )
    );

    return h("article", {
      class: "op" + (op.modified ? " is-modified" : "") + (op.active ? "" : " is-inactive"),
      id: id,
      "aria-label": op.method.toUpperCase() + " " + op.route
    },
      h("div", { class: "op-head" },
        methodBadge(op.method),
        h("span", { class: "op-route", text: op.route }),
        h("div", { class: "op-tags" }, tags)
      ),
      op.summary || op.description ? h("p", { class: "op-desc", text: op.summary || op.description }) : null,
      meta.length ? h("div", { class: "op-meta" }, meta) : null,
      modeButtons(op, id),
      body,
      h("div", { class: "op-foot" },
        h("span", { class: "serving" }, "Serving ", h("strong", { text: servingLabel(op, current) })),
        h("label", { class: "delay-field", title: "Artificial latency before responding" }, "Delay",
          h("input", {
            type: "number",
            min: "0",
            step: "100",
            id: id + "-delay",
            value: op.delay ? String(op.delay) : "",
            placeholder: "0",
            onchange: function (e) {
              var ms = Number(e.target.value) || 0;
              e.target.blur();
              select(op, { delay: ms }, ms ? ms + " ms delay" : "no delay").catch(function () {});
            }
          }), "ms"),
        h("span", { class: "spacer" }),
        h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-toggle",
          "aria-expanded": drawerOpen ? "true" : "false",
          "aria-controls": id + "-drawer",
          text: drawerOpen ? "Hide preview" : "Preview & try",
          onclick: function () {
            if (ui.openDrawers.has(id)) ui.openDrawers.delete(id); else ui.openDrawers.add(id);
            render();
          }
        }),
        h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-link",
          title: "Copy a GET link that switches to this response – open it in a browser or call it from a test",
          text: "Copy link",
          onclick: function () { copyText(link, "Switch link copied"); }
        }),
        h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-curl",
          title: "Copy a curl command that switches to this response",
          text: "Copy curl",
          onclick: function () { copyText(curl, "curl command copied"); }
        }),
        op.modified ? h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-reset",
          text: "Reset",
          onclick: function () { resetOne(op); }
        }) : null
      ),
      drawer
    );
  }

  function sendTry(op, id) {
    var path = (ui.tryUrls.get(id) || sampleUrl(op)).trim();
    if (!path.startsWith("http://") && !path.startsWith("https://") && path.charAt(0) !== "/") {
      path = "/" + path;
    }
    var started = performance.now();
    var init = { method: op.method.toUpperCase(), headers: { Accept: "application/json" } };
    if (["post", "put", "patch"].indexOf(op.method) >= 0) {
      init.headers["Content-Type"] = "application/json";
      init.body = "{}";
    }
    fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = text;
        try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not JSON */ }
        ui.tryResults.set(id, { status: res.status, body: body, type: res.headers.get("Content-Type"), ms: Math.round(performance.now() - started) });
      });
    }).catch(function (err) {
      ui.tryResults.set(id, { error: err.message, ms: Math.round(performance.now() - started) });
    }).then(function () {
      render();
      pollLog();
    });
  }

  function copyText(text, message) {
    var done = function () { toast(message); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = h("textarea", { class: "sr-only", readonly: true });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed – select the text manually", true); }
    area.remove();
  }

  /* ------------------------------------------------------------ request log */

  function renderLog() {
    var entries = ui.logEntries.slice().reverse();
    el.logEmpty.hidden = entries.length > 0;
    el.log.replaceChildren.apply(el.log, entries.map(function (entry) {
      return h("li", { class: ui.freshLogIds.has(entry.id) ? "is-new" : "" },
        methodBadge(entry.method),
        h("span", { class: statusClass(entry.status), text: entry.status ? String(entry.status) : "→" }),
        h("span", { class: "log-path", text: entry.path }),
        h("span", { class: "log-meta" },
          entry.source === "msw" ? h("span", { class: "log-source", title: "Answered by MSW in a browser or test", text: "msw" }) : null,
          h("span", { text: timeOf(entry.time) }),
          h("span", { text: entry.example === "empty" ? "no body" : entry.example }),
          entry.ms !== undefined ? h("span", { text: entry.ms + " ms" }) : null,
          entry.specId ? h("span", { text: entry.specId }) : null
        )
      );
    }));
    ui.freshLogIds.clear();
  }

  function pollLog() {
    return api("/api/log?since=" + ui.logSince).then(function (res) {
      var entries = res.entries || [];
      if (!entries.length) return;
      entries.forEach(function (e) {
        ui.logSince = Math.max(ui.logSince, e.id);
        if (e.id > ui.logClearedAt) {
          ui.logEntries.push(e);
          ui.freshLogIds.add(e.id);
        }
      });
      if (ui.logEntries.length > LOG_KEEP) ui.logEntries.splice(0, ui.logEntries.length - LOG_KEEP);
      renderLog();
    });
  }

  /* ------------------------------------------------------------ wiring */

  el.filterText.addEventListener("input", function (e) {
    ui.filterText = e.target.value;
    renderOperations();
  });

  el.filterModified.addEventListener("change", function (e) {
    ui.onlyModified = e.target.checked;
    renderOperations();
  });

  el.reload.addEventListener("click", function () {
    withBusy(el.reload, function () {
      return api("/api/reload", {}).then(function (state) {
        applyState(state);
        var failed = state.specs.filter(function (s) { return s.error; });
        var breaking = (state.changes || []).reduce(function (n, r) { return n + r.counts.breaking; }, 0);
        if (failed.length) toast(failed.length + " spec(s) failed to load – see the Specs panel", true);
        else if (breaking) toast("Reloaded – " + breaking + " breaking contract change(s) detected", true);
        else toast("Reloaded " + state.specs.length + " spec(s) from disk");
      }, function (err) { toast(err.message, true); });
    });
  });

  el.resetAll.addEventListener("click", function () {
    withBusy(el.resetAll, function () {
      ui.drafts.clear();
      return api("/api/reset", {}).then(function (res) {
        applyState(res.state);
        toast("Reset " + res.reset + " endpoint(s) to their defaults");
      }, function (err) { toast(err.message, true); });
    });
  });

  el.clearLog.addEventListener("click", function () {
    ui.logClearedAt = ui.logSince;
    ui.logEntries = [];
    renderLog();
  });

  refreshState()
    .catch(function (err) {
      el.content.replaceChildren(h("div", { class: "empty", text: "Could not reach swaggerizer: " + err.message }));
    })
    .then(pollLog)
    .catch(function () {});

  setInterval(function () {
    if (document.hidden) return;
    // Catch up on anything that arrived while a field was being edited.
    if (ui.pendingOps && !isEditing()) render();
    refreshState().catch(function () {});
  }, STATE_POLL_MS);

  setInterval(function () {
    if (document.hidden) return;
    pollLog().catch(function () {});
  }, LOG_POLL_MS);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshState().catch(function () {});
  });
})();
