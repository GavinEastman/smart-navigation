/* Smart Navigation — core logic (no UI). Works in the browser and in Node tests. */
(function (root) {
  'use strict';

  // ---------- Service-time formula (from the original SMART Navigation) ----------
  // Game = 3 min each. RT: Fill = 5, Swap = 10, No Fill = 0. Payout tickets = 12 (only when no RT).
  // Non-ACH = 7, ACH = 0, unknown = 0. 1 collector: everything. 2 collectors: RT minutes excluded.
  // 3 collectors: (everything) / 2, rounded up. A manual override replaces the estimate.
  const RT_MIN = { 'No Fill': 0, Fill: 5, Swap: 10 };
  function serviceMinutes(stop, collectors) {
    if (stop.service_override != null && stop.service_override !== '') return Number(stop.service_override);
    const games = Math.max(0, Number(stop.games) || 0);
    const rt = !!stop.has_rt;
    const rtMinutes = rt ? (RT_MIN[stop.rt_task] || 0) : 0;
    const payout = !rt && stop.payout_tickets === true ? 12 : 0;
    const base = games * 3 + payout + (stop.ach === false ? 7 : 0);
    const c = Number(collectors) || 1;
    if (c === 2) return base;
    if (c === 3) return Math.ceil((base + rtMinutes) / 2);
    return base + rtMinutes;
  }

  // ---------- Distance / route solving ----------
  function haversine(a, b) {
    const R = 6371e3, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function pathCost(order, m, closeLoop) {
    let c = 0;
    for (let i = 0; i < order.length - 1; i++) c += m[order[i]][order[i + 1]];
    if (closeLoop) c += m[order[order.length - 1]][order[0]];
    return c;
  }

  /**
   * Best visiting order for matrix m.
   * Index 0 is always the start. If fixedEnd, index n-1 is always last.
   * closeLoop = return to start after the last stop.
   * Returns an array of indices beginning with 0.
   */
  function solve(m, { fixedEnd = false, closeLoop = false } = {}) {
    const n = m.length;
    if (n <= 2) return [...Array(n).keys()];
    const lastFree = fixedEnd ? n - 2 : n - 1; // highest index that can move
    const free = [];
    for (let i = 1; i <= lastFree; i++) free.push(i);

    const cost = (o) => pathCost(o, m, closeLoop);
    const build = (mid) => (fixedEnd ? [0, ...mid, n - 1] : [0, ...mid]);

    // Several nearest-neighbour starts, keep the best after local search
    let bestOrder = null, bestCost = Infinity;
    const seeds = [null, ...free.slice().sort((a, b) => m[0][a] - m[0][b]).slice(0, Math.min(4, free.length))];
    for (const seed of seeds) {
      const left = new Set(free);
      const mid = [];
      let cur = 0;
      if (seed != null) { mid.push(seed); left.delete(seed); cur = seed; }
      while (left.size) {
        let best = -1, bd = Infinity;
        for (const j of left) if (m[cur][j] < bd) { bd = m[cur][j]; best = j; }
        mid.push(best); left.delete(best); cur = best;
      }
      const order = improve(build(mid), m, cost, fixedEnd);
      const c = cost(order);
      if (c < bestCost - 1e-9) { bestCost = c; bestOrder = order; }
    }
    return bestOrder;
  }

  function improve(order, m, cost, fixedEnd) {
    const n = order.length;
    const hi = fixedEnd ? n - 2 : n - 1; // last movable position
    let best = cost(order);
    let changed = true, rounds = 0;
    while (changed && rounds < 60) {
      changed = false; rounds++;
      // 2-opt: reverse a segment
      for (let i = 1; i < hi; i++) {
        for (let k = i + 1; k <= hi; k++) {
          const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
          const c = cost(cand);
          if (c < best - 1e-9) { order = cand; best = c; changed = true; }
        }
      }
      // Or-opt: move a run of 1–3 stops elsewhere
      for (let len = 1; len <= 3; len++) {
        for (let i = 1; i + len - 1 <= hi; i++) {
          const seg = order.slice(i, i + len);
          const rest = order.slice(0, i).concat(order.slice(i + len));
          const restHi = hi - len;
          for (let j = 1; j <= restHi + 1; j++) {
            if (j === i) continue;
            const cand = rest.slice(0, j).concat(seg, rest.slice(j));
            const c = cost(cand);
            if (c < best - 1e-9) { order = cand; best = c; changed = true; break; }
          }
        }
      }
    }
    return order;
  }

  // ---------- CSV / spreadsheet import ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  const yesNo = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (['y', 'yes', 'true', '1', 'x'].includes(s)) return true;
    if (['n', 'no', 'false', '0'].includes(s)) return false;
    return null;
  };

  function rowsToStops(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const col = (...names) => {
      let i = header.findIndex((h) => names.includes(h));
      if (i < 0) i = header.findIndex((h) => names.some((n) => n.length > 3 && h.includes(n)));
      return i;
    };
    const c = {
      addr: col('address', 'street address', 'street', 'addr', 'address 1', 'address1'),
      city: col('city', 'town'),
      state: col('state', 'st', 'province'),
      zip: col('zip', 'zip code', 'zipcode', 'postal code', 'postcode'),
      name: col('name', 'location name', 'location', 'customer', 'business', 'company'),
      phone: col('phone', 'location phone', 'telephone', 'tel'),
      notes: col('notes', 'note', 'comments', 'instructions'),
      games: col('games', 'skill game count', 'skill games', 'game count'),
      rt: col('rt', 'redemption terminal', 'redemption terminals', 'has rt'),
      ach: col('ach'),
      payout: col('payout tickets', 'payout'),
    };
    const looksLikeHeader = (c.addr >= 0 || c.city >= 0 || c.zip >= 0) && !rows[0].some((v) => /\d{3,}/.test(String(v)));
    const body = looksLikeHeader ? rows.slice(1) : rows;
    return body.map((r) => {
      const g = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      if (!looksLikeHeader) {
        return { address: r.map((f) => String(f).trim()).filter(Boolean).join(', '), name: '' };
      }
      const stateZip = [g(c.state), g(c.zip)].filter(Boolean).join(' ');
      const address = [g(c.addr), g(c.city), stateZip].filter(Boolean).join(', ');
      const s = { address, name: g(c.name), phone: g(c.phone), notes: g(c.notes) };
      if (c.games >= 0 && g(c.games) !== '') s.games = parseInt(g(c.games), 10) || 0;
      if (c.rt >= 0) {
        const v = g(c.rt);
        s.has_rt = yesNo(v) === true || /[1-9]|countr|kiosk/i.test(v);
      }
      if (c.ach >= 0) s.ach = yesNo(g(c.ach));
      if (c.payout >= 0) s.payout_tickets = s.has_rt ? false : yesNo(g(c.payout));
      return s;
    }).filter((s) => s.address);
  }

  // ---------- Service time for a saved location (strict rules) ----------
  // G = confirmed skill games × 3. RT = sum of each terminal's task (Fill 5, Swap 10, None 0).
  // A = Non-ACH 7, ACH 0. P = payout tickets 12, only when there is no RT and payout is Yes.
  // Crew 1: G+RT+A+P. Crew 2: G+A+P (RT excluded). Crew 3: ceil((G+RT+A+P)/2).
  // Anything unknown is reported in `missing` and the stop can't be optimized until fixed.
  const RT_TASK_MIN = { None: 0, Fill: 5, Swap: 10 };
  function locationService({ games, ach, payout, rtCount, rtTasks }, collectors) {
    const missing = [];
    if (games == null) missing.push('skill game count not confirmed');
    if (ach == null) missing.push('ACH unknown');
    if (!rtCount && payout == null) missing.push('payout tickets unknown');
    const tasks = Array.from({ length: rtCount || 0 }, (_, i) => (rtTasks && rtTasks[i]) || 'Fill'); // default task is Fill
    const G = (games || 0) * 3;
    const RT = tasks.reduce((a, t) => a + (RT_TASK_MIN[t] || 0), 0);
    const A = ach === false ? 7 : 0;
    const P = !rtCount && payout === true ? 12 : 0;
    const c = Number(collectors) || 1;
    const minutes = c === 2 ? G + A + P : c === 3 ? Math.ceil((G + RT + A + P) / 2) : G + RT + A + P;
    return { minutes, missing, tasks };
  }

  // ---------- Business hours ----------
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function parseClock(s) {
    const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]?\.?$/);
    if (!m) return null;
    let h = +m[1]; const min = +(m[2] || 0);
    if (h < 1 || h > 12 || min > 59) return null;
    if (/p/i.test(m[3]) && h !== 12) h += 12;
    if (/a/i.test(m[3]) && h === 12) h = 0;
    return h * 60 + min;
  }
  /** One day's hours text → list of [openMin, closeMin] (close may exceed 1440 = after midnight),
   *  [] = closed, null = unknown. "22", "-", blank and equal open/close are treated as unknown. */
  function parseDayHours(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '-' || s === '—' || s === '22' || /^(none|n\/a|unknown)$/i.test(s)) return null;
    if (/^closed$/i.test(s)) return [];
    if (/24\s*(hours|hrs|h)|open 24/i.test(s)) return [[0, 1440]];
    const out = [];
    for (const part of s.split(/[;,]/)) {
      if (!part.trim()) continue;
      const m = part.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
      if (!m) return null;
      const o = parseClock(m[1]); let c = parseClock(m[2]);
      if (o == null || c == null || o === c) return null;
      if (c < o) c += 1440;
      out.push([o, c]);
    }
    return out.length ? out : null;
  }
  const is247 = (comment) => /24\s*\/\s*7|24 hours|open 24/i.test(String(comment || ''));

  /**
   * Opening windows (absolute ms) around a route day.
   * dayStart: Date at local midnight of the route day. Looks at the day before (for after-midnight
   * closing) through `days` days ahead. Returns { anytime } | { unknown } | { windows: [[a,b],...] }.
   */
  function openWindows(hours, comment, open247, dayStart, days = 2) {
    if (open247 || is247(comment)) return { anytime: true };
    const y = dayStart.getFullYear(), mo = dayStart.getMonth(), d0 = dayStart.getDate();
    const windows = [];
    for (let d = -1; d <= days; d++) {
      const date = new Date(y, mo, d0 + d);
      const iv = parseDayHours((hours || {})[DAYS[date.getDay()]]);
      // Hours not filled in yet: treat as open any time so the stop still gets scheduled,
      // but remember they're unknown so the app can still say "Hours unknown".
      if (iv == null) { if (d === 0) return { anytime: true, unknownHours: true }; continue; }
      for (const [o, c] of iv) {
        windows.push([new Date(y, mo, d0 + d, 0, o).getTime(), new Date(y, mo, d0 + d, 0, c).getTime()]);
      }
    }
    windows.sort((a, b) => a[0] - b[0]);
    return { windows };
  }

  /** Earliest time service can start at/after `arrive` and still finish by closing. null = can't. */
  function earliestStart(win, arrive, durMs) {
    if (!win || win.unknown) return null;
    if (win.anytime) return arrive;
    for (const [a, b] of win.windows) {
      const s = Math.max(arrive, a);
      if (s + durMs <= b) return s;
    }
    return null;
  }

  /**
   * Hours-aware route plan. Index 0 of m is the shop (start & finish).
   * stops[i-1] = { win, svcMin }. Returns { order (indices ≥1 that fit), unscheduled (indices), finish }.
   */
  const HORIZON_MS = 24 * 3600 * 1000; // a route must finish within 24 hours of leaving the shop
  function simulate(order, m, stops, dep) {
    let clock = dep, prev = 0, early = 0;
    const seq = [], unscheduled = [];
    for (const i of order) {
      const st = stops[i - 1];
      const arrive = clock + m[prev][i] * 1000;
      const start = earliestStart(st.win, arrive, st.svcMin * 60000);
      if (start == null || start + st.svcMin * 60000 + m[i][0] * 1000 > dep + HORIZON_MS) { unscheduled.push(i); continue; }
      seq.push(i); clock = start + st.svcMin * 60000; prev = i; early += start - dep;
    }
    const finish = clock + m[prev][0] * 1000;
    // Main goal: fit every stop, then get back to the shop soonest.
    // Small tie-breaker: visit stops earlier rather than sitting and waiting for a late opener.
    return { seq, unscheduled, finish, cost: unscheduled.length * 1e13 + finish + early * 0.02 };
  }

  function scheduleRoute(m, stops, dep) {
    const n = m.length;
    if (n <= 1) return { order: [], unscheduled: [], finish: dep };
    const all = [...Array(n - 1).keys()].map((i) => i + 1);
    const evalO = (o) => simulate(o, m, stops, dep).cost;
    const closeOf = (i) => { const w = stops[i - 1].win; return w.anytime ? Infinity : w.unknown ? Infinity : (w.windows.find((x) => x[1] > dep) || [0, Infinity])[1]; };
    const seeds = [
      solve(m, { closeLoop: true }).slice(1),
      all.slice().sort((a, b) => closeOf(a) - closeOf(b) || m[0][a] - m[0][b]),
    ];
    let best = null, bestC = Infinity;
    for (let order of seeds) {
      let c = evalO(order), changed = true, rounds = 0;
      while (changed && rounds < 30) {
        changed = false; rounds++;
        for (let i = 0; i < order.length - 1; i++) {
          for (let k = i + 1; k < order.length; k++) {
            const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
            const cc = evalO(cand);
            if (cc < c - 1) { order = cand; c = cc; changed = true; }
          }
        }
        for (let i = 0; i < order.length; i++) {
          for (let j = 0; j < order.length; j++) {
            if (i === j) continue;
            const cand = order.slice(); const [x] = cand.splice(i, 1); cand.splice(j, 0, x);
            const cc = evalO(cand);
            if (cc < c - 1) { order = cand; c = cc; changed = true; }
          }
        }
      }
      if (c < bestC) { bestC = c; best = order; }
    }
    const r = simulate(best, m, stops, dep);
    return { order: r.seq, unscheduled: r.unscheduled, finish: r.finish };
  }

  // ---------- Formatting ----------
  const fmtMiles = (m) => `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
  function fmtDur(sec) {
    const t = Math.round(sec / 60), h = Math.floor(t / 60), m = t % 60;
    return h ? `${h}h ${m}m` : `${m} min`;
  }
  function fmtClock(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const api = {
    serviceMinutes, haversine, pathCost, solve, parseCSV, rowsToStops, yesNo, fmtMiles, fmtDur, fmtClock,
    locationService, DAYS, parseClock, parseDayHours, is247, openWindows, earliestStart, simulate, scheduleRoute,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SN = api;
})(typeof window !== 'undefined' ? window : globalThis);
