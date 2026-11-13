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

  // ---------- Formatting ----------
  const fmtMiles = (m) => `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
  function fmtDur(sec) {
    const t = Math.round(sec / 60), h = Math.floor(t / 60), m = t % 60;
    return h ? `${h}h ${m}m` : `${m} min`;
  }
  function fmtClock(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const api = { serviceMinutes, haversine, pathCost, solve, parseCSV, rowsToStops, yesNo, fmtMiles, fmtDur, fmtClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SN = api;
})(typeof window !== 'undefined' ? window : globalThis);
