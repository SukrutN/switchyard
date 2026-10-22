/* yardmaster console - vanilla wiring, no framework.
   Polls /api/state every 2 s, renders the yard, and refuses to
   pretend: a dark yard prints its refusal in its own words.
   Pauses while the tab is hidden (a hidden console is not watched). */

(function () {
  "use strict";

  var POLL_MS = 2000;
  var timer = null;
  var live = false;   // last poll was a truthful snapshot
  var activeLane = null;
  var activeKey = null;
  var kvLane = null;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    target: $("gate-target"), tls: $("gate-tls"), token: $("gate-token"),
    live: $("gate-live"), dot: $("gate-dot"), word: $("gate-word"),
    yardgrid: $("yardgrid"), yardNote: $("yard-note"),
    lanesBody: $("lanes-body"), lanesNote: $("lanes-note"),
    drill: $("drill"), drillLane: $("drill-lane"),
    drillFacts: $("drill-facts"), consBody: $("cons-body"), drillNote: $("drill-note"),
    kvLane: $("kv-lane"), keys: $("keylist"), kvNote: $("kv-note"),
    valuePlate: $("value-plate"), valueKey: $("value-key"),
    valueMeta: $("value-meta"), valueBody: $("value-body")
  };

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MiB";
    return (n / 1073741824).toFixed(2) + " GiB";
  }

  function fmtUptime(s) {
    var m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return d + "d " + (h % 24) + "h";
    if (h) return h + "h " + (m % 60) + "m";
    if (m) return m + "m " + (s % 60) + "s";
    return s + "s";
  }

  /* ---------- meta / gate plates ---------- */

  function paintMeta(meta) {
    el.target.textContent = meta.target || "-";
    el.tls.textContent = meta.tls ? "wrap on" : "plain";
    el.tls.style.color = meta.tls ? "" : "var(--signal)";
    el.token.textContent = meta.tokened ? "gate up" : "auth off";
    el.token.style.color = meta.tokened ? "" : "var(--signal)";
  }

  function setLive(ok) {
    if (ok === live) return;
    live = ok;
    el.live.classList.toggle("gateplate--dark", !ok);
    el.word.textContent = ok ? "watching" : "the yard is dark";
  }

  /* ---------- the yard ---------- */

  function paintYard(snap) {
    if (snap.dark) {
      setLive(false);
      el.yardgrid.innerHTML = "";
      el.lanesBody.innerHTML = "";
      el.yardNote.className = "note note--dark";
      el.yardNote.textContent = "the yard is dark - " +
        (snap.dark.code ? snap.dark.code + " / " : "") + snap.dark.reason;
      el.lanesNote.textContent = "";
      $("drill").hidden = true;
      return;
    }
    setLive(true);
    var y = snap.yard;
    var rows = [
      ["version", y.version, true],
      ["uptime", fmtUptime(y.uptime_sec), false],
      ["sessions", String(y.sessions), false],
      ["lanes", String(y.lanes.length), false]
    ];
    el.yardgrid.innerHTML = rows.map(function (r) {
      return "<div><dt>" + r[0] + "</dt><dd>" +
        (r[2] ? "<span class='mono'>" + esc(r[1]) + "</span>" : esc(r[1])) +
        "</dd></div>";
    }).join("");

    var note = "";
    if ((y.quarantined || []).length) {
      note = "quarantined (writes refused until restart): " +
        y.quarantined.join(", ");
      el.yardNote.className = "note note--warn";
    } else {
      if (!y.lanes.length) {
        note = "(no lanes - a memory-only yard journals nothing)";
      }
      el.yardNote.className = "note";
    }
    el.yardNote.textContent = note;
  }

  /* ---------- lanes + drilldown ---------- */

  function paintLanes(snap) {
    if (!snap.yard) { el.lanesNote.textContent = ""; return; }
    var lanes = snap.yard.lanes;
    el.lanesBody.innerHTML = lanes.map(function (ln) {
      return "<tr data-lane='" + esc(ln.name) + "'" +
        (ln.name === activeLane ? " class='dl--active'" : "") + ">" +
        "<td class='lane-name'>" + esc(ln.name) + "</td>" +
        "<td class='num'>" + ln.seq + "</td>" +
        "<td class='num'>" + fmtBytes(ln.journal_bytes) + "</td>" +
        "<td class='num'>" + ln.key_count + "</td>" +
        "<td class='num'>" + ln.consumers.length + "</td>" +
        "<td>" + (ln.quarantined ? "<span class='chip chip--q'>quarantined</span>" : "") +
        (ln.error ? "<span class='chip chip--err'>" + esc(ln.error) + "</span>" : "") +
        "</td></tr>";
    }).join("");
    if (!lanes.length) { el.lanesNote.textContent = ""; }
    Array.prototype.forEach.call(
      el.lanesBody.querySelectorAll("tr"), function (tr) {
        tr.addEventListener("click", function () { pickLane(tr.dataset.lane); });
      });
  }

  function paintDrill() {
    if (!activeLane) { $("drill").hidden = true; return; }
    var ln = findLane(activeLane);
    if (!ln) { el.drillNote.textContent = "the lane left the list"; return; }
    $("drill").hidden = false;
    el.drillLane.textContent = activeLane;
    el.drillFacts.innerHTML = fact("seq", String(ln.seq), false) +
      fact("journal", fmtBytes(ln.journal_bytes), false) +
      fact("keys", String(ln.key_count), false) +
      fact("consumers", String(ln.consumers.length), false);
    el.consBody.innerHTML = ln.consumers.length
      ? ln.consumers.map(function (csm) {
          return "<tr><td>" + esc(csm.name) + "</td>" +
            "<td class='num'>" + csm.floor + "</td>" +
            "<td class='num'>" + csm.pending + "</td>" +
            "<td><span class='chip " + (csm.attached ? "" : "") + (csm.attached ? "chip--a" : "") + "'>" +
            (csm.attached ? "attached" : "detached") + "</span></td></tr>";
        }).join("")
      : "<tr><td colspan='4'>(no consumers - the lane waits for its first one)</td></tr>";
    el.drillNote.textContent = "floor is the durable position a consumer resumes from";
  }

  function fact(k, v, hot) {
    return "<div><dt>" + k + "</dt><dd>" +
      (hot ? "<span class='mono'>" + esc(v) + "</span>" : esc(v)) + "</dd></div>";
  }

  function findLane(name) {
    if (!window.__snap || !window.__snap.yard) return null;
    for (var i = 0; i < window.__snap.yard.lanes.length; i++) {
      if (window.__snap.yard.lanes[i].name === name) {
        return window.__snap.yard.lanes[i];
      }
    }
    return null;
  }

  function pickLane(name) {
    activeLane = (activeLane === name) ? null : name;
    paintLanes(window.__snap);
    paintDrill();
  }

  /* ---------- kv (read-only) ---------- */

  function paintLaneSelect(lanes) {
    var sel = el.kvLane;
    var names = lanes.map(function (ln) { return ln.name; });
    var same =
      sel.options.length === names.length &&
      Array.prototype.every.call(sel.options, function (o, i) { return o.value === names[i]; });
    if (!same) {
      sel.innerHTML = names.map(function (n) {
        return "<option value='" + esc(n) + "'>" + esc(n) + "</option>";
      }).join("");
      if (!names.includes(kvLane)) kvLane = names[0] || null;
      sel.value = kvLane || "";
    }
  }

  function loadKeys() {
    if (!kvLane) { el.keys.innerHTML = ""; el.kvNote.textContent = ""; return; }
    fetch("/api/keys?lane=" + encodeURIComponent(kvLane), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.dark) {
          el.keys.innerHTML = "";
          el.kvNote.textContent = "refused - " +
            (j.dark.code ? j.dark.code + " / " : "") + j.dark.reason;
          el.kvNote.className = "note note--warn";
          return;
        }
        el.kvNote.textContent = j.keys.length + " key(s)";
        el.kvNote.className = "note";
        el.keys.innerHTML = j.keys.map(function (k) {
          return "<li data-key='" + esc(k) + "'" +
            (k === activeKey ? " class='active'" : "") + ">" + esc(k) + "</li>";
        }).join("");
        Array.prototype.forEach.call(el.keys.children, function (li) {
          li.addEventListener("click", function () { pickKey(li.dataset.key, li); });
        });
        if (!activeKey) { /* nothing selected yet */ }
      })
      .catch(function () {
        el.kvNote.textContent = "the console lost its mouth - check the binary's log";
        el.kvNote.className = "note note--warn";
      });
  }

  function pickKey(key, li) {
    activeKey = key;
    Array.prototype.forEach.call(el.keys.children, function (o) {
      o.classList.toggle("active", o === li);
    });
    fetch("/api/value?lane=" + encodeURIComponent(kvLane) +
          "&key=" + encodeURIComponent(key), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.dark) {
          el.valuePlate.hidden = false;
          el.valueKey.textContent = key;
          el.valueMeta.textContent = "refused";
          el.valueBody.textContent = (j.dark.code ? j.dark.code + " / " : "") + j.dark.reason;
          return;
        }
        if (!j.found) {
          el.valuePlate.hidden = false;
          el.valueKey.textContent = key;
          el.valueMeta.textContent = "absent - nothing is written there";
          el.valueBody.textContent = "";
          return;
        }
        el.valuePlate.hidden = false;
        el.valueKey.textContent = key;
        el.valueMeta.textContent = "seq " + j.seq + " | " + j.bytes + " B" +
          (j.cut ? " | preview cut" : "");
        el.valueBody.textContent = j.text != null && j.text.length
          ? j.text : "(" + j.bytes + " bytes, not printable text)";
      });
  }

  /* ---------- escape ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- the poll ---------- */

  function tick() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (snap) {
        window.__snap = snap;
        paintMeta(snap.meta);
        paintYard(snap);
        paintLanes(snap);
        paintDrill();
        if (snap.yard) {
          paintLaneSelect(snap.yard.lanes);
          /* keys refresh rarely; only when not already mid-browse */
          if (!document.activeElement || document.activeElement !== el.kvLane) loadKeys();
        }
      })
      .catch(function () { setLive(false); });
  }

  function schedule() {
    if (timer) window.clearTimeout(timer);
    if (document.hidden) { timer = null; return; } // a hidden tab is not being watched
    tick();
    timer = window.setTimeout(schedule, POLL_MS);
  }

  document.addEventListener("visibilitychange", schedule);
  el.kvLane.addEventListener("change", function () {
    kvLane = el.kvLane.value;
    activeKey = null;
    el.valuePlate.hidden = true;
    loadKeys();
  });

  schedule();
})();
