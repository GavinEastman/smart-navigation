/* Smart Navigation — app UI. Plain JavaScript, no build step. */
'use strict';

// ======================================================================
// Setup
// ======================================================================
const CFG = window.SN_CONFIG || {};
const CONFIGURED = !!CFG.SUPABASE_URL && !/YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY);
const sb = window.supabase.createClient(
  CONFIGURED ? CFG.SUPABASE_URL : 'https://example.supabase.co',
  CONFIGURED ? CFG.SUPABASE_ANON_KEY : 'public-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
);

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org';
const MAX_STOPS = 98; // OSRM public table limit = 100 points incl. start + end
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

const S = {
  session: null,
  routes: [],
  route: null,
  stops: [],
  geoFailed: new Set(),
  me: null,
  prefs: { nav: 'auto', country: 'US' },
};

// ======================================================================
// Small helpers
// ======================================================================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOwner = () => !!S.session && (S.session.user.email || '').toLowerCase() === String(CFG.OWNER_EMAIL || '').toLowerCase();
const isFinished = (s) => s.status !== 'pending';
const located = (s) => s.lat != null && s.lng != null;

let toastT;
function toast(msg, ms = 3000) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(on) { $('busy').classList.toggle('hidden', !on); }

function loadPrefs() {
  try { Object.assign(S.prefs, JSON.parse(localStorage.getItem('sn.prefs') || '{}')); } catch (e) { /* */ }
}
function savePrefs() { try { localStorage.setItem('sn.prefs', JSON.stringify(S.prefs)); } catch (e) { /* */ } }

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  try { localStorage.setItem('sn.theme', dark ? 'dark' : 'light'); } catch (e) { /* */ }
}

// Tap twice to confirm (system confirm() popups are unreliable in installed web apps)
function twoTap(btn, fn, label = 'Tap again to confirm') {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; fn(); return; }
  btn.dataset.orig = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; } }, 3500);
}

function dbErr(error, what = 'Save') {
  if (!error) return false;
  console.error(error);
  toast(`${what} failed: ${error.message || error}`);
  return true;
}

// Bottom sheet
function openSheet(html, mount) {
  $('sheetBody').innerHTML = html;
  $('sheet').classList.remove('hidden');
  if (mount) mount($('sheetBody'));
}
function closeSheet() { $('sheet').classList.add('hidden'); $('sheetBody').innerHTML = ''; }

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// ======================================================================
// Views
// ======================================================================
const VIEWS = { login: 'vLogin', routes: 'vRoutes', route: 'vRoute', settings: 'vSettings', team: 'vTeam' };
let currentView = 'login';
function show(name) {
  Object.values(VIEWS).forEach((id) => $(id).classList.add('hidden'));
  $(VIEWS[name]).classList.remove('hidden');
  currentView = name;
  window.scrollTo(0, 0);
  if (name === 'routes') loadRoutes();
  if (name === 'settings') renderSettings();
  if (name === 'team') loadTeam();
  if (name === 'route' && map) setTimeout(() => map.invalidateSize(), 50);
}

// ======================================================================
// Auth
// ======================================================================
async function initAuth() {
  if (!CONFIGURED) { $('setupWarn').classList.remove('hidden'); show('login'); return; }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((evt, session) => {
    S.session = session;
    if (!session && currentView !== 'login') { show('login'); }
  });
  if (S.session) {
    // Make sure the account still exists (removed accounts are kicked out)
    const { error } = await sb.auth.getUser();
    if (error) { await sb.auth.signOut(); S.session = null; }
  }
  show(S.session ? 'routes' : 'login');
}

async function login(e) {
  e.preventDefault();
  if (!CONFIGURED) { $('loginErr').textContent = 'The app is not set up yet (config.js).'; return; }
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email: $('loginEmail').value.trim(), password: $('loginPass').value });
  $('loginBtn').disabled = false;
  if (error) { $('loginErr').textContent = /invalid/i.test(error.message) ? 'Wrong email or password.' : error.message; return; }
  S.session = data.session;
  $('loginPass').value = '';
  show('routes');
}

// Re-check the account whenever the app comes back to the foreground
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.session) return;
  const { error } = await sb.auth.getUser();
  if (error && /not found|invalid|expired|jwt/i.test(error.message || '')) {
    await sb.auth.signOut(); toast('You have been signed out.');
  }
});

// ======================================================================
// Routes list
// ======================================================================
async function loadRoutes() {
  const { data, error } = await sb.from('routes')
    .select('id,name,route_date,collectors,total_distance,total_drive,stops(status)')
    .order('route_date', { ascending: false }).order('created_at', { ascending: false });
  if (dbErr(error, 'Loading routes')) return;
  S.routes = data || [];
  renderRoutes();
}

function renderRoutes() {
  const list = $('routesList');
  $('routesEmpty').classList.toggle('hidden', S.routes.length > 0);
  list.innerHTML = S.routes.map((r) => {
    const total = r.stops.length, done = r.stops.filter((s) => s.status !== 'pending').length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bits = [`${total} stop${total === 1 ? '' : 's'}`];
    if (r.total_distance) bits.push(SN.fmtMiles(r.total_distance));
    if (r.total_drive) bits.push(SN.fmtDur(r.total_drive) + ' driving');
    return `<div class="route-card" data-id="${r.id}">
      <div class="row between"><div class="name">${esc(r.name)}</div><span class="tag">${esc(fmtDate(r.route_date))}</span></div>
      <div class="meta">${bits.join(' · ')}${total ? ` · ${done}/${total} done` : ''}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

async function newRoute() {
  const d = todayISO();
  const { data, error } = await sb.from('routes').insert({ name: `Route – ${fmtDate(d)}`, route_date: d }).select('*').single();
  if (dbErr(error, 'Creating route')) return;
  openRoute(data.id);
}

// ======================================================================
// Route: load / save
// ======================================================================
async function openRoute(id) {
  busy(true);
  const [{ data: route, error: e1 }, { data: stops, error: e2 }] = await Promise.all([
    sb.from('routes').select('*').eq('id', id).single(),
    sb.from('stops').select('*').eq('route_id', id).order('position'),
  ]);
  busy(false);
  if (dbErr(e1 || e2, 'Opening route')) return;
  S.route = route; S.stops = stops || []; S.geoFailed.clear();
  show('route');
  initMap();
  renderRoute(true);
  geocodeMissing();
}

async function updateRoute(patch) {
  Object.assign(S.route, patch);
  const { error } = await sb.from('routes').update(patch).eq('id', S.route.id);
  dbErr(error);
}

async function updateStop(stop, patch) {
  Object.assign(stop, patch);
  const { error } = await sb.from('stops').update(patch).eq('id', stop.id);
  dbErr(error);
}

async function savePositions() {
  S.stops.forEach((s, i) => { s.position = i + 1; });
  const rows = S.stops.map((s) => ({ id: s.id, route_id: s.route_id, owner_id: s.owner_id, address: s.address, position: s.position }));
  const { error } = await sb.from('stops').upsert(rows, { onConflict: 'id' });
  dbErr(error, 'Saving order');
}

function markStale() {
  if (S.route.legs) updateRoute({ legs: null, geometry: null, total_distance: null, total_drive: null });
}

// ======================================================================
// Address search (Photon) and geocoding
// ======================================================================
function bias() {
  if (S.me) return S.me;
  if (map) { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; }
  return null;
}

function photonToPlace(f) {
  const p = f.properties || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const town = p.city || p.town || p.village || p.district || p.county || '';
  const stateZip = [p.state, p.postcode].filter(Boolean).join(' ');
  const isPOI = p.name && p.osm_key && !['place', 'highway', 'building', 'boundary'].includes(p.osm_key);
  const line1 = street || (isPOI ? '' : p.name) || '';
  const address = [line1, town, stateZip].filter(Boolean).join(', ') || p.name || '';
  return {
    name: isPOI ? p.name : '',
    address,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    country: (p.countrycode || '').toUpperCase(),
  };
}

async function photonSearch(q, limit = 6) {
  const params = new URLSearchParams({ q, limit: String(limit * 2), lang: 'en' });
  const b = bias();
  if (b) { params.set('lat', b.lat.toFixed(4)); params.set('lon', b.lng.toFixed(4)); }
  const res = await fetch(`${PHOTON}?${params}`);
  if (!res.ok) throw new Error('search ' + res.status);
  const data = await res.json();
  let places = (data.features || []).map(photonToPlace).filter((p) => p.address);
  if (S.prefs.country) places = places.filter((p) => p.country === S.prefs.country);
  return places.slice(0, limit);
}

let lastNominatim = 0;
async function nominatim(q) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '1' });
  if (S.prefs.country) params.set('countrycodes', S.prefs.country.toLowerCase());
  const res = await fetch(`${NOMINATIM}?${params}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.length ? { lat: +d[0].lat, lng: +d[0].lon } : null;
}

async function geocode(address) {
  try {
    const r = await photonSearch(address, 1);
    if (r.length) return { lat: r[0].lat, lng: r[0].lng };
  } catch (e) { /* fall through */ }
  try { return await nominatim(address); } catch (e) { return null; }
}

let geocoding = false;
async function geocodeMissing() {
  if (geocoding) return;
  geocoding = true;
  try {
    const routeId = S.route && S.route.id;
    let todo = S.stops.filter((s) => !located(s) && !S.geoFailed.has(s.id));
    let i = 0;
    while (todo.length && S.route && S.route.id === routeId) {
      const s = todo.shift(); i++;
      $('geoStatus').textContent = `Finding addresses… ${i} of ${i + todo.length}`;
      const g = await geocode(s.address);
      if (g) await updateStop(s, { lat: g.lat, lng: g.lng });
      else S.geoFailed.add(s.id);
      renderRoute();
      await sleep(250);
    }
    const bad = S.stops.filter((s) => !located(s)).length;
    $('geoStatus').textContent = bad ? `⚠️ ${bad} address${bad > 1 ? 'es' : ''} not found — tap the stop to fix it.` : '';
    if (i) renderRoute(true);
  } finally { geocoding = false; }
}

// ======================================================================
// Adding stops
// ======================================================================
async function addStops(list) {
  const room = MAX_STOPS - S.stops.length;
  if (room <= 0) { toast(`A route can have up to ${MAX_STOPS} stops.`); return 0; }
  if (list.length > room) toast(`Only the first ${room} stops were added (limit ${MAX_STOPS}).`);
  const start = S.stops.length;
  const rows = list.slice(0, room).map((s, i) => {
    const r = {
      route_id: S.route.id, position: start + i + 1,
      address: String(s.address).slice(0, 500), name: (s.name || '').slice(0, 200),
      phone: s.phone || '', notes: s.notes || '',
      lat: s.lat ?? null, lng: s.lng ?? null,
    };
    if (s.games != null) r.games = Math.min(200, Math.max(0, s.games | 0));
    if (s.has_rt != null) r.has_rt = !!s.has_rt;
    if (s.ach !== undefined) r.ach = s.ach;
    if (s.payout_tickets !== undefined) r.payout_tickets = r.has_rt ? false : s.payout_tickets;
    return r;
  });
  busy(true);
  const { data, error } = await sb.from('stops').insert(rows).select('*');
  busy(false);
  if (dbErr(error, 'Adding stops')) return 0;
  S.stops.push(...data.sort((a, b) => a.position - b.position));
  markStale();
  renderRoute(true);
  geocodeMissing();
  return data.length;
}

// Search box with suggestions
let searchT, searchSeq = 0, searchHits = [];
function onSearchInput() {
  const q = $('searchInput').value.trim();
  clearTimeout(searchT);
  if (q.length < 3) { hideResults(); return; }
  searchT = setTimeout(async () => {
    const seq = ++searchSeq;
    let hits = [];
    try { hits = await photonSearch(q); } catch (e) { /* offline */ }
    if (seq !== searchSeq) return;
    searchHits = hits;
    const box = $('searchResults');
    box.innerHTML = hits.map((h, i) => `<div class="sr" data-i="${i}"><div class="t">${esc(h.name || h.address.split(',')[0])}</div><div class="d">${esc(h.address)}</div></div>`).join('')
      + `<div class="sr" data-i="typed"><div class="t">➕ Add “${esc(q)}” as typed</div><div class="d">We'll look it up</div></div>`;
    box.classList.remove('hidden');
  }, 300);
}
function hideResults() { $('searchResults').classList.add('hidden'); }
async function pickResult(i) {
  const q = $('searchInput').value.trim();
  const place = i === 'typed' ? { address: q } : searchHits[+i];
  if (!place) return;
  $('searchInput').value = ''; hideResults();
  const n = await addStops([place]);
  if (n) toast(`Added: ${place.name || place.address}`);
}

function openPaste() {
  openSheet(`<h2>Paste a list</h2><div class="sub">One address per line. Copy them from a text, email or spreadsheet.</div>
    <textarea id="pasteBox" rows="8" placeholder="301 E Howard St, Hooper, NE&#10;310 N Oakland Ave, Oakland, NE"></textarea>
    <button class="btn primary block mt" id="pasteAdd">Add stops</button>
    <button class="btn secondary block mt" id="pasteCancel">Cancel</button>`, (el) => {
    el.querySelector('#pasteCancel').onclick = closeSheet;
    el.querySelector('#pasteAdd').onclick = async () => {
      const text = el.querySelector('#pasteBox').value;
      let list;
      if (text.includes('\t')) list = SN.rowsToStops(SN.parseCSV(text)); // pasted from a spreadsheet
      else list = text.split('\n').map((l) => l.trim()).filter(Boolean).map((address) => ({ address }));
      closeSheet();
      if (!list.length) return;
      const n = await addStops(list);
      if (n) toast(`Added ${n} stops`);
    };
  });
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function importFile(file) {
  try {
    let rows;
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      busy(true);
      await loadScript(XLSX_URL);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      busy(false);
    } else {
      rows = SN.parseCSV(await file.text());
    }
    const list = SN.rowsToStops(rows);
    if (!list.length) { toast('No addresses found in that file.'); return; }
    const n = await addStops(list);
    if (n) toast(`Imported ${n} stops`);
  } catch (e) {
    busy(false); console.error(e); toast('Could not read that file.');
  }
}

// ======================================================================
// Optimization + drive times
// ======================================================================
function getGPS(timeout = 12000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { S.me = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(S.me); },
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 }
    );
  });
}

async function osrmTable(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  try {
    const res = await fetch(`${OSRM}/table/v1/driving/${coords}?annotations=duration`);
    const d = await res.json();
    if (d.code !== 'Ok') throw new Error(d.code);
    return d.durations.map((r) => r.map((v) => (v == null ? 1e7 : v)));
  } catch (e) {
    toast('Live drive times unavailable — using straight-line estimate.');
    return points.map((a) => points.map((b) => SN.haversine(a, b) / 13));
  }
}

async function osrmRoute(points) {
  try {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const res = await fetch(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const d = await res.json();
    if (d.code !== 'Ok') return null;
    const r = d.routes[0];
    // keep the line light: every 3rd point
    const line = r.geometry.coordinates.filter((_, i, a) => i % 3 === 0 || i === a.length - 1).map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]);
    return { line, legs: r.legs.map((l) => ({ s: l.duration, m: l.distance })), distance: r.distance, duration: r.duration };
  } catch (e) { return null; }
}

// The shop is always the start and the finish of every route.
let shopCache = null;
function cachedShop() {
  if (CFG.SHOP_LAT != null && CFG.SHOP_LNG != null) return { lat: +CFG.SHOP_LAT, lng: +CFG.SHOP_LNG };
  if (shopCache) return shopCache;
  try {
    const c = JSON.parse(localStorage.getItem('sn.shop') || 'null');
    if (c && c.address === CFG.SHOP_ADDRESS) return (shopCache = { lat: c.lat, lng: c.lng });
  } catch (e) { /* */ }
  return null;
}
async function getShop() {
  const c = cachedShop();
  if (c) return c;
  const g = await geocode(CFG.SHOP_ADDRESS);
  if (!g) return null;
  shopCache = g;
  try { localStorage.setItem('sn.shop', JSON.stringify({ address: CFG.SHOP_ADDRESS, ...g })); } catch (e) { /* */ }
  return g;
}

async function optimize(keepOrder = false) {
  const pending = S.stops.filter((s) => !isFinished(s) && located(s));
  if (!pending.length) { toast('No remaining stops with a found address.'); return; }
  busy(true);
  try {
    const shop = await getShop();
    if (!shop) { toast("Couldn't find the shop address. Check your connection, or set SHOP_LAT/SHOP_LNG in config.js."); return; }
    const start = { ...shop, kind: 'shop' };
    const end = null;
    const closeLoop = true; // always finish back at the shop

    let ordered = pending;
    if (!keepOrder && pending.length > 1) {
      const pts = [start, ...pending, ...(end ? [end] : [])];
      const m = await osrmTable(pts);
      const order = SN.solve(m, { fixedEnd: !!end, closeLoop });
      ordered = order.filter((i) => i >= 1 && i <= pending.length).map((i) => pending[i - 1]);
    }

    // finished stops stay on top, then the plan, then anything without an address match
    const finished = S.stops.filter(isFinished);
    const unlocated = S.stops.filter((s) => !isFinished(s) && !located(s));
    S.stops = [...finished, ...ordered, ...unlocated];
    await savePositions();

    const routePts = [start, ...ordered];
    if (end) routePts.push(end); else if (closeLoop) routePts.push(start);
    const geo = await osrmRoute(routePts);
    const legs = {
      start: { lat: start.lat, lng: start.lng, kind: start.kind },
      items: ordered.map((s, i) => ({ id: s.id, s: geo ? geo.legs[i].s : null, m: geo ? geo.legs[i].m : null })),
      back: geo && (end || closeLoop) ? geo.legs[geo.legs.length - 1] : null,
      at: new Date().toISOString(),
    };
    await updateRoute({
      legs,
      geometry: geo ? geo.line : routePts.map((p) => [p.lat, p.lng]),
      total_distance: geo ? geo.distance : null,
      total_drive: geo ? geo.duration : null,
      optimized_at: new Date().toISOString(),
    });
    renderRoute(true);
    toast(keepOrder ? 'Times updated ✔' : 'Route optimized ✔');
  } finally { busy(false); }
}

// ETA plan — valid only while the stop order matches the last calculation
function computePlan() {
  const r = S.route, legs = r.legs;
  const collectors = r.collectors || 1;
  const serviceTotal = S.stops.filter((s) => !isFinished(s)).reduce((a, s) => a + SN.serviceMinutes(s, collectors), 0);
  const plan = { valid: false, eta: {}, serviceTotal, finish: null };
  if (!legs || !legs.items) return plan;
  const ids = legs.items.map((x) => x.id);
  const inOrder = S.stops.filter((s) => ids.includes(s.id)).map((s) => s.id);
  const pendingLocated = S.stops.filter((s) => !isFinished(s) && located(s)).map((s) => s.id);
  if (inOrder.join() !== ids.join() || pendingLocated.some((id) => !ids.includes(id))) return plan;
  if (legs.items.some((x) => x.s == null)) return plan;

  let clock;
  if (r.start_time) clock = new Date(`${r.route_date}T${r.start_time}`);
  else clock = new Date(legs.at || r.optimized_at);
  const byId = Object.fromEntries(S.stops.map((s) => [s.id, s]));
  for (const it of legs.items) {
    const st = byId[it.id];
    // Running late or early? Once a stop is marked done, every later ETA
    // is recalculated from the moment it was actually finished.
    if (isFinished(st)) {
      if (st.completed_at) clock = new Date(st.completed_at);
      continue;
    }
    clock = new Date(clock.getTime() + it.s * 1000);
    plan.eta[it.id] = new Date(clock);
    clock = new Date(clock.getTime() + SN.serviceMinutes(st, collectors) * 60000);
  }
  if (legs.back) clock = new Date(clock.getTime() + legs.back.s * 1000);
  plan.finish = clock;
  plan.valid = true;
  return plan;
}

// ======================================================================
// Navigation links
// ======================================================================
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function navUrl(s) {
  let app = S.prefs.nav;
  if (app === 'auto') app = isIOS() ? 'apple' : 'google';
  const dest = located(s) ? `${s.lat},${s.lng}` : encodeURIComponent(s.address);
  if (app === 'apple') return `https://maps.apple.com/?daddr=${dest}&dirflg=d`;
  if (app === 'waze') return located(s) ? `https://waze.com/ul?ll=${dest}&navigate=yes` : `https://waze.com/ul?q=${dest}&navigate=yes`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}
function openGoogleMulti() {
  const next = S.stops.filter((s) => !isFinished(s) && located(s)).slice(0, 10);
  if (!next.length) { toast('No remaining stops.'); return; }
  const dest = next[next.length - 1];
  const wps = next.slice(0, -1).map((s) => `${s.lat},${s.lng}`).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
  if (wps) url += `&waypoints=${encodeURIComponent(wps)}`;
  window.open(url, '_blank');
}

// ======================================================================
// Map
// ======================================================================
let map, mapLayer, meMarker;
function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 60); return; }
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([41.25, -96.0], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
}
const pinIcon = (cls, text) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

function drawMap(fit) {
  if (!map) return;
  mapLayer.clearLayers();
  const pts = [];
  const r = S.route;
  if (r.geometry && r.geometry.length > 1) L.polyline(r.geometry, { color: '#B6DB3C', weight: 6, opacity: 0.95 }).addTo(mapLayer);
  if (r.geometry && r.geometry.length > 1) L.polyline(r.geometry, { color: '#123D31', weight: 2, opacity: 0.9 }).addTo(mapLayer);
  const shop = cachedShop() || (r.legs && r.legs.start);
  if (shop) {
    L.marker([shop.lat, shop.lng], { icon: pinIcon('start', '🏠'), zIndexOffset: -100 })
      .bindPopup(`<b>${esc(CFG.SHOP_NAME || 'Shop')}</b><br>Start &amp; finish<br>${esc(CFG.SHOP_ADDRESS)}`).addTo(mapLayer);
    pts.push([shop.lat, shop.lng]);
  }
  const next = S.stops.find((s) => !isFinished(s) && located(s));
  S.stops.forEach((s, i) => {
    if (!located(s)) return;
    const cls = s === next ? 'next' : s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : s.status === 'skipped' ? 'done' : '';
    L.marker([s.lat, s.lng], { icon: pinIcon(cls, i + 1), zIndexOffset: s === next ? 1000 : 0 })
      .on('click', () => openStop(s.id)).addTo(mapLayer);
    pts.push([s.lat, s.lng]);
  });
  if (fit && pts.length) map.fitBounds(pts, { padding: [36, 36], maxZoom: 15 });
}

async function locateMe() {
  const g = await getGPS();
  if (!g) { toast('Location not available. Allow location for this site in your phone settings.'); return; }
  if (meMarker) meMarker.remove();
  meMarker = L.marker([g.lat, g.lng], { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
  map.setView([g.lat, g.lng], Math.max(map.getZoom(), 13));
}

// ======================================================================
// Route rendering
// ======================================================================
function svcTags(s) {
  const t = [];
  if (s.games) t.push(`🎰 ${s.games}`);
  if (s.has_rt) t.push(`RT${s.rt_task && s.rt_task !== 'No Fill' ? ' ' + s.rt_task : ''}`);
  if (s.ach === true) t.push('ACH'); else if (s.ach === false) t.push('Non-ACH');
  if (!s.has_rt && s.payout_tickets === true) t.push('Payout tix');
  return t;
}

function renderRoute(fit = false) {
  const r = S.route;
  if (!r) return;
  $('routeName').textContent = r.name;
  $('routeDate').textContent = r.name.includes(fmtDate(r.route_date)) ? '' : fmtDate(r.route_date);
  const plan = computePlan();
  const total = S.stops.length, done = S.stops.filter(isFinished).length;

  // Summary tiles
  const drive = plan.valid && r.total_drive ? SN.fmtDur(r.total_drive) : '—';
  const miles = plan.valid && r.total_distance ? SN.fmtMiles(r.total_distance) : '—';
  $('summary').innerHTML = `
    <div class="s"><div class="v">${done}/${total}</div><div class="k">Stops</div></div>
    <div class="s"><div class="v">${miles}</div><div class="k">Distance</div></div>
    <div class="s"><div class="v">${drive}</div><div class="k">Drive</div></div>
    <div class="s"><div class="v">${plan.valid ? SN.fmtClock(plan.finish) : SN.fmtDur(plan.serviceTotal * 60)}</div><div class="k">${plan.valid ? 'Finish' : 'Service'}</div></div>`;

  $('btnKeepOrder').classList.toggle('hidden', total < 1);
  $('stopCount').textContent = total ? `${total} stop${total > 1 ? 's' : ''} · ${r.collectors} collector${r.collectors > 1 ? 's' : ''}` : 'No stops yet — search above to add some';
  if (total && !plan.valid && S.stops.some((s) => !isFinished(s) && located(s))) {
    $('stopCount').textContent += ' · tap Optimize to plan';
  }

  // Next stop card
  const next = S.stops.find((s) => !isFinished(s) && located(s));
  const nc = $('nextCard');
  if (next && plan.valid) {
    const idx = S.stops.indexOf(next) + 1;
    const svc = SN.serviceMinutes(next, r.collectors);
    nc.innerHTML = `<div class="lab">NEXT STOP · #${idx}</div>
      <div class="nm">${esc(next.name || next.address.split(',')[0])}</div>
      <div class="ad">${esc(next.address)}</div>
      <div class="eta">ETA ${SN.fmtClock(plan.eta[next.id])} · ${svc} min on site</div>
      <div class="row">
        <a class="btn lime" href="${navUrl(next)}" target="_blank" rel="noopener">➤ Navigate</a>
        <button class="btn secondary" data-done="${next.id}">✔ Done</button>
        <button class="btn secondary" data-open="${next.id}">Details</button>
      </div>`;
    nc.classList.remove('hidden');
  } else nc.classList.add('hidden');

  // Stop list
  $('stopList').innerHTML = S.stops.map((s, i) => {
    const cls = ['stop', s === next ? 'next' : '', s.status].join(' ');
    const svc = SN.serviceMinutes(s, r.collectors);
    const tags = svcTags(s);
    const eta = plan.valid && plan.eta[s.id] && !isFinished(s) ? `<div class="t">${SN.fmtClock(plan.eta[s.id])}</div>` : '';
    const status = s.status === 'done' ? '<span class="tag done">Done</span>' : s.status === 'failed' ? '<span class="tag failed">Failed</span>' : s.status === 'skipped' ? '<span class="tag">Skipped</span>' : '';
    const bad = !located(s) ? (S.geoFailed.has(s.id) ? '<div class="bad">Address not found — tap to fix</div>' : '<div class="bad">Finding address…</div>') : '';
    return `<li class="${cls}" data-open="${s.id}">
      <div class="num">${i + 1}</div>
      <div class="body">
        ${s.name ? `<div class="nm">${esc(s.name)}</div>` : ''}
        <div class="ad">${esc(s.address)}</div>
        <div class="ex">${tags.map(esc).join(' · ')}${svc ? `${tags.length ? ' · ' : ''}⏱ ${svc} min` : ''}${s.notes ? ` · 📝 ${esc(s.notes.slice(0, 40))}${s.notes.length > 40 ? '…' : ''}` : ''}</div>
        ${bad}
      </div>
      <div class="side">${eta}${status}</div>
    </li>`;
  }).join('');
  drawMap(fit);
}

// ======================================================================
// Stop sheet
// ======================================================================
function seg(name, options, value, disabled = false) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-v="${v}" class="${String(value) === String(v) ? 'on' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
}

function openStop(id) {
  const s = S.stops.find((x) => x.id === id);
  if (!s) return;
  const idx = S.stops.indexOf(s) + 1;
  const r = S.route;
  const tri = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unk');
  const statusBtns = s.status === 'pending'
    ? `<button class="btn ok" data-st="done">✔ Done</button><button class="btn danger" data-st="failed">✖ Failed</button><button class="btn secondary" data-st="skipped">Skip</button>`
    : `<button class="btn secondary" data-st="pending" style="grid-column: span 3">↺ Mark as not done (${esc(s.status)})</button>`;

  openSheet(`
    <h2>#${idx} ${esc(s.name || s.address.split(',')[0])}</h2>
    <div class="sub">${esc(s.address)}</div>
    <div class="actions">
      <a class="btn primary" href="${navUrl(s)}" target="_blank" rel="noopener">➤ Navigate</a>
      ${s.phone ? `<a class="btn secondary" href="tel:${esc(s.phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : '<button class="btn secondary" disabled>📞 No phone</button>'}
      <button class="btn secondary" id="stMove">↕ Move</button>
    </div>
    <div class="actions">${statusBtns}</div>
    <label class="lbl" for="stNote">Delivery / visit note</label>
    <textarea id="stNote" rows="2" placeholder="e.g. closed, manager not in, left with bartender">${esc(s.status_note)}</textarea>

    <div class="card mt">
      <div class="card-title">Service time</div>
      <div class="svc"><span class="lb">Skill games</span>
        <div class="stepper"><button type="button" id="gMinus">−</button><span id="gVal">${s.games}</span><button type="button" id="gPlus">+</button></div></div>
      <div class="svc"><span class="lb">Redemption terminal</span>${seg('has_rt', [['false', 'No'], ['true', 'Yes']], s.has_rt)}</div>
      <div id="rtTaskRow" class="${s.has_rt ? '' : 'hidden'}"><div class="lbl">RT task</div>${seg('rt_task', [['No Fill', 'No Fill'], ['Fill', 'Fill'], ['Swap', 'Swap']], s.rt_task)}</div>
      <div class="lbl">ACH</div>${seg('ach', [['yes', 'ACH'], ['no', 'Non-ACH'], ['unk', 'Unknown']], tri(s.ach))}
      <div class="lbl">Payout tickets${s.has_rt ? ' (not allowed with an RT)' : ''}</div>${seg('payout_tickets', [['yes', 'Yes'], ['no', 'No'], ['unk', 'Unknown']], s.has_rt ? 'no' : tri(s.payout_tickets), s.has_rt)}
      <label class="lbl" for="stOverride">Override minutes (leave blank for automatic)</label>
      <input id="stOverride" type="number" inputmode="numeric" min="0" max="1440" value="${s.service_override ?? ''}">
      <div class="est"><span>Estimated on site (${r.collectors} collector${r.collectors > 1 ? 's' : ''})</span><b id="estVal">${SN.serviceMinutes(s, r.collectors)} min</b></div>
    </div>

    <div class="card">
      <div class="card-title">Stop details</div>
      <label class="lbl" for="stName">Name / location</label><input id="stName" type="text" value="${esc(s.name)}">
      <label class="lbl" for="stAddr">Address</label><input id="stAddr" type="text" value="${esc(s.address)}">
      <label class="lbl" for="stPhone">Phone</label><input id="stPhone" type="text" inputmode="tel" value="${esc(s.phone)}">
      <label class="lbl" for="stNotes">Notes</label><textarea id="stNotes" rows="3">${esc(s.notes)}</textarea>
      <button class="btn primary block mt" id="stSave">Save details</button>
    </div>
    <button class="btn danger block" id="stDelete">Delete stop</button>
    <button class="btn secondary block mt" id="stClose">Close</button>
  `, (el) => {
    const refreshEst = () => { el.querySelector('#estVal').textContent = `${SN.serviceMinutes(s, r.collectors)} min`; renderRoute(); };
    const fromTri = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

    el.querySelector('#stClose').onclick = closeSheet;

    el.querySelectorAll('[data-st]').forEach((b) => b.onclick = async () => {
      const st = b.dataset.st;
      await updateStop(s, { status: st, status_note: el.querySelector('#stNote').value.trim(), completed_at: st === 'pending' ? null : new Date().toISOString() });
      closeSheet(); renderRoute();
      if (st === 'done') toast('Marked done ✔');
    });
    el.querySelector('#stNote').onchange = (e) => updateStop(s, { status_note: e.target.value.trim() });

    // service fields
    const setGames = (n) => { n = Math.max(0, Math.min(200, n)); el.querySelector('#gVal').textContent = n; updateStop(s, { games: n }).then(refreshEst); s.games = n; refreshEst(); };
    el.querySelector('#gMinus').onclick = () => setGames(s.games - 1);
    el.querySelector('#gPlus').onclick = () => setGames(s.games + 1);
    el.querySelectorAll('[data-seg]').forEach((sg) => sg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const f = sg.dataset.seg, v = b.dataset.v;
      if (f === 'has_rt') {
        const rt = v === 'true';
        const patch = { has_rt: rt };
        if (rt) patch.payout_tickets = false;
        updateStop(s, patch).then(() => { closeSheet(); openStop(s.id); renderRoute(); });
        return;
      }
      if (f === 'rt_task') updateStop(s, { rt_task: v });
      if (f === 'ach') updateStop(s, { ach: fromTri(v) });
      if (f === 'payout_tickets') updateStop(s, { payout_tickets: fromTri(v) });
      refreshEst();
    });
    el.querySelector('#stOverride').onchange = (e) => {
      const v = e.target.value.trim();
      updateStop(s, { service_override: v === '' ? null : Math.max(0, Math.min(1440, parseInt(v, 10) || 0)) }).then(refreshEst);
    };

    // details
    el.querySelector('#stSave').onclick = async () => {
      const addr = el.querySelector('#stAddr').value.trim();
      const patch = { name: el.querySelector('#stName').value.trim(), phone: el.querySelector('#stPhone').value.trim(), notes: el.querySelector('#stNotes').value.trim() };
      if (addr && addr !== s.address) { Object.assign(patch, { address: addr, lat: null, lng: null }); S.geoFailed.delete(s.id); }
      await updateStop(s, patch);
      if (patch.address) { markStale(); geocodeMissing(); }
      closeSheet(); renderRoute(); toast('Saved');
    };

    el.querySelector('#stMove').onclick = () => {
      openSheet(`<h2>Move stop</h2><div class="sub">${esc(s.name || s.address)}</div>
        <label class="lbl" for="mvTo">New position (1–${S.stops.length})</label>
        <input id="mvTo" type="number" inputmode="numeric" min="1" max="${S.stops.length}" value="${idx}">
        <div class="actions"><button class="btn secondary" id="mvFirst">First</button><button class="btn secondary" id="mvLast">Last</button><button class="btn primary" id="mvGo">Move</button></div>
        <div class="hint">After moving, tap <b>Keep my order</b> to update the times.</div>`, (m) => {
        const move = async (to) => {
          to = Math.max(1, Math.min(S.stops.length, to | 0));
          S.stops.splice(S.stops.indexOf(s), 1); S.stops.splice(to - 1, 0, s);
          closeSheet(); renderRoute(); await savePositions(); renderRoute();
        };
        m.querySelector('#mvFirst').onclick = () => move(1);
        m.querySelector('#mvLast').onclick = () => move(S.stops.length);
        m.querySelector('#mvGo').onclick = () => move(+m.querySelector('#mvTo').value);
      });
    };

    el.querySelector('#stDelete').onclick = (e) => twoTap(e.currentTarget, async () => {
      const { error } = await sb.from('stops').delete().eq('id', s.id);
      if (dbErr(error, 'Delete')) return;
      S.stops = S.stops.filter((x) => x.id !== s.id);
      closeSheet(); renderRoute(true); savePositions();
    });
  });
}

// ======================================================================
// Route settings sheet (name, date, crew, start & end)
// ======================================================================
function openRouteSettings() {
  const r = S.route;
  const draft = { collectors: r.collectors };
  openSheet(`
    <h2>Route settings</h2>
    <label class="lbl" for="rsName">Route name</label><input id="rsName" type="text" value="${esc(r.name)}">
    <div class="row gap6">
      <div style="flex:1"><label class="lbl" for="rsDate">Date</label><input id="rsDate" type="date" value="${esc(r.route_date)}"></div>
      <div style="flex:1"><label class="lbl" for="rsTime">Start time</label><input id="rsTime" type="time" value="${esc((r.start_time || '').slice(0, 5))}"></div>
    </div>
    <div class="hint">Leave start time blank to plan from when you tap Optimize.</div>
    <div class="lbl">Collectors on this route</div>${seg('collectors', [[1, '1'], [2, '2'], [3, '3']], r.collectors)}

    <div class="lbl">Start &amp; finish</div>
    <div class="est"><span>🏠 ${esc(CFG.SHOP_NAME || 'Shop')}<br><small class="hint">${esc(CFG.SHOP_ADDRESS)}</small></span></div>

    <button class="btn primary block mt" id="rsSave">Save</button>
    <div class="card mt">
      <div class="card-title">More</div>
      <button class="btn secondary block" id="rsDup">Duplicate this route</button>
      <button class="btn secondary block mt" id="rsReset">Mark all stops as not done</button>
      <button class="btn danger block mt" id="rsDelete">Delete route</button>
    </div>
    <button class="btn secondary block" id="rsClose">Close</button>
  `, (el) => {
    el.querySelector('#rsClose').onclick = closeSheet;
    el.querySelectorAll('[data-seg]').forEach((sg) => sg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const f = sg.dataset.seg;
      draft[f] = +b.dataset.v;
    });
    el.querySelector('#rsSave').onclick = async () => {
      const patch = {
        name: el.querySelector('#rsName').value.trim() || 'Route',
        route_date: el.querySelector('#rsDate').value || todayISO(),
        start_time: el.querySelector('#rsTime').value || null,
        collectors: draft.collectors,
      };
      await updateRoute(patch);
      closeSheet(); renderRoute(true); toast('Saved');
    };
    el.querySelector('#rsDup').onclick = async () => {
      busy(true);
      const { id, created_at, updated_at, owner_id, legs, geometry, total_distance, total_drive, optimized_at, ...rest } = r;
      const { data: nr, error } = await sb.from('routes').insert({ ...rest, name: `${r.name} (copy)`, route_date: todayISO() }).select('*').single();
      if (dbErr(error, 'Duplicate')) { busy(false); return; }
      const rows = S.stops.map(({ id: _i, created_at: _c, owner_id: _o, route_id: _r, status, status_note, completed_at, ...s }) => ({ ...s, route_id: nr.id }));
      if (rows.length) { const { error: e2 } = await sb.from('stops').insert(rows); if (dbErr(e2, 'Duplicate')) { busy(false); return; } }
      busy(false); closeSheet(); toast('Route duplicated'); openRoute(nr.id);
    };
    el.querySelector('#rsReset').onclick = (e) => twoTap(e.currentTarget, async () => {
      const { error } = await sb.from('stops').update({ status: 'pending', status_note: '', completed_at: null }).eq('route_id', r.id);
      if (dbErr(error)) return;
      S.stops.forEach((s) => Object.assign(s, { status: 'pending', status_note: '', completed_at: null }));
      markStale(); closeSheet(); renderRoute(true);
    });
    el.querySelector('#rsDelete').onclick = (e) => twoTap(e.currentTarget, async () => {
      const { error } = await sb.from('routes').delete().eq('id', r.id);
      if (dbErr(error, 'Delete')) return;
      closeSheet(); S.route = null; S.stops = []; show('routes'); toast('Route deleted');
    });
  });
}

// ======================================================================
// Settings
// ======================================================================
function renderSettings() {
  $('accEmail').textContent = S.session ? S.session.user.email : '';
  $('setNav').value = S.prefs.nav;
  $('setCountry').value = S.prefs.country;
  $('setDark').checked = document.documentElement.dataset.theme === 'dark';
  $('lnkWorkOrders').href = CFG.WORK_ORDERS_URL || '#';
}

// ======================================================================
// Manage team (owner only — the server enforces this too)
// ======================================================================
async function teamCall(body) {
  const { data, error } = await sb.functions.invoke('manage-team', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function genPassword() {
  const words = ['Route', 'Truck', 'Smart', 'Map', 'Drive', 'Stop', 'Road', 'Turn', 'Lime', 'Green', 'River', 'Plains'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const n = 100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900);
  return `${pick()}${pick()}${n}!`;
}

async function loadTeam() {
  if (!isOwner()) { show('settings'); return; }
  $('teamList').innerHTML = '<div class="hint">Loading…</div>';
  try {
    const { users } = await teamCall({ action: 'list' });
    $('teamCount').textContent = `Team (${users.length} account${users.length === 1 ? '' : 's'})`;
    $('teamList').innerHTML = users.map((u) => `
      <div class="user-row">
        <div class="nm">${esc(u.name || u.email.split('@')[0])}${u.is_owner ? '<span class="owner-badge">OWNER</span>' : ''}</div>
        <div class="em">${esc(u.email)}</div>
        <div class="meta">Last sign-in: ${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : 'never'}</div>
        <div class="row gap6">
          <button class="btn secondary sm" data-reset="${u.id}" data-email="${esc(u.email)}">Reset password</button>
          <button class="btn secondary sm" data-rename="${u.id}" data-name="${esc(u.name)}">Rename</button>
          ${u.is_owner ? '' : `<button class="btn danger sm" data-remove="${u.id}">Remove</button>`}
        </div>
      </div>`).join('');
  } catch (e) {
    $('teamList').innerHTML = `<div class="err">${esc(e.message)}</div><div class="hint">Check that the <b>manage-team</b> function is deployed and the OWNER_EMAIL secret matches your email (README step 4).</div>`;
  }
}

function showPassword(email, pw) {
  openSheet(`<h2>Account ready</h2><div class="sub">Give these to your teammate. They can't change the password themselves.</div>
    <div class="card"><div class="lbl">Email</div><div class="strong">${esc(email)}</div><div class="lbl">Password</div><div class="strong" style="font-size:20px">${esc(pw)}</div></div>
    <button class="btn primary block" id="cpBtn">Copy email &amp; password</button>
    <button class="btn secondary block mt" id="cpClose">Done</button>`, (el) => {
    el.querySelector('#cpClose').onclick = closeSheet;
    el.querySelector('#cpBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(`Smart Navigation login\nEmail: ${email}\nPassword: ${pw}\nApp: ${location.href.split('#')[0]}`); toast('Copied'); }
      catch (e) { toast('Copy not allowed — write it down instead.'); }
    };
  });
}

async function addUser(e) {
  e.preventDefault();
  const email = $('nuEmail').value.trim(), password = $('nuPass').value, name = $('nuName').value.trim();
  $('btnAddUser').disabled = true; $('addUserMsg').textContent = '';
  try {
    await teamCall({ action: 'create', email, password, name });
    $('addUserForm').reset();
    showPassword(email, password);
    loadTeam();
  } catch (err) { $('addUserMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`; }
  $('btnAddUser').disabled = false;
}

function onTeamClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.remove) {
    twoTap(b, async () => {
      try { await teamCall({ action: 'delete', user_id: b.dataset.remove }); toast('Account removed'); loadTeam(); }
      catch (err) { toast(err.message); }
    }, 'Tap again to remove');
  }
  if (b.dataset.reset) {
    const email = b.dataset.email, id = b.dataset.reset, pw0 = genPassword();
    openSheet(`<h2>Reset password</h2><div class="sub">${esc(email)}</div>
      <label class="lbl" for="rpPass">New password</label>
      <div class="row gap6"><input id="rpPass" type="text" value="${esc(pw0)}" autocomplete="off"><button class="btn secondary" id="rpGen">Generate</button></div>
      <button class="btn primary block mt" id="rpSave">Set new password</button>
      <button class="btn secondary block mt" id="rpCancel">Cancel</button>`, (el) => {
      el.querySelector('#rpCancel').onclick = closeSheet;
      el.querySelector('#rpGen').onclick = () => { el.querySelector('#rpPass').value = genPassword(); };
      el.querySelector('#rpSave').onclick = async () => {
        const pw = el.querySelector('#rpPass').value;
        try { await teamCall({ action: 'reset', user_id: id, password: pw }); showPassword(email, pw); }
        catch (err) { toast(err.message); }
      };
    });
  }
  if (b.dataset.rename) {
    const id = b.dataset.rename;
    openSheet(`<h2>Rename</h2><label class="lbl" for="rnName">Name</label><input id="rnName" type="text" value="${esc(b.dataset.name)}">
      <button class="btn primary block mt" id="rnSave">Save</button><button class="btn secondary block mt" id="rnCancel">Cancel</button>`, (el) => {
      el.querySelector('#rnCancel').onclick = closeSheet;
      el.querySelector('#rnSave').onclick = async () => {
        try { await teamCall({ action: 'rename', user_id: id, name: el.querySelector('#rnName').value }); closeSheet(); loadTeam(); }
        catch (err) { toast(err.message); }
      };
    });
  }
}

// ======================================================================
// Wire up
// ======================================================================
function bind() {
  $('loginForm').onsubmit = login;
  document.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => show(b.dataset.go));
  $('btnNewRoute').onclick = newRoute;
  $('routesList').onclick = (e) => { const c = e.target.closest('.route-card'); if (c) openRoute(c.dataset.id); };

  $('btnBack').onclick = () => { S.route = null; show('routes'); };
  $('btnRouteSettings').onclick = openRouteSettings;
  $('btnRouteTitle').onclick = openRouteSettings;
  $('btnMapToggle').onclick = () => {
    const w = $('mapWrap'); w.classList.toggle('collapsed');
    $('btnMapToggle').textContent = w.classList.contains('collapsed') ? 'Show map' : 'Hide map';
    setTimeout(() => { map.invalidateSize(); drawMap(true); }, 60);
  };
  $('btnLocate').onclick = locateMe;

  $('searchInput').oninput = onSearchInput;
  $('searchInput').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (searchHits.length && !$('searchResults').classList.contains('hidden')) pickResult(0); }
    if (e.key === 'Escape') hideResults();
  };
  $('searchResults').onclick = (e) => { const r = e.target.closest('.sr'); if (r) pickResult(r.dataset.i); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) hideResults(); });

  $('btnPaste').onclick = openPaste;
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('btnOptimize').onclick = () => optimize(false);
  $('btnKeepOrder').onclick = () => optimize(true);
  $('btnNavMulti').onclick = openGoogleMulti;

  const openFromList = (e) => {
    const d = e.target.closest('[data-done]');
    if (d) {
      const s = S.stops.find((x) => x.id === d.dataset.done);
      if (s) updateStop(s, { status: 'done', completed_at: new Date().toISOString() }).then(() => { renderRoute(); toast('Marked done ✔'); });
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o && !e.target.closest('a')) openStop(o.dataset.open);
  };
  $('stopList').onclick = openFromList;
  $('nextCard').onclick = openFromList;

  $('sheet').onclick = (e) => { if (e.target === $('sheet')) closeSheet(); };

  $('btnSignOut').onclick = async () => { await sb.auth.signOut(); S.session = null; show('login'); };
  $('setNav').onchange = (e) => { S.prefs.nav = e.target.value; savePrefs(); };
  $('setCountry').onchange = (e) => { S.prefs.country = e.target.value; savePrefs(); };
  $('setDark').onchange = (e) => setTheme(e.target.checked);

  // Hidden entrance to Manage Team: tap the version line at the bottom of Settings 7 times.
  // Nothing happens for anyone except the owner (and the server checks again).
  let taps = 0, tapT;
  $('versionTap').onclick = () => {
    clearTimeout(tapT); tapT = setTimeout(() => { taps = 0; }, 2500);
    if (++taps >= 7) { taps = 0; if (isOwner()) show('team'); }
  };

  $('addUserForm').onsubmit = addUser;
  $('btnGenPass').onclick = () => { $('nuPass').value = genPassword(); };
  $('teamList').onclick = onTeamClick;
  $('btnTeamRefresh').onclick = loadTeam;
}

// ======================================================================
// Boot
// ======================================================================
loadPrefs();
bind();
initAuth();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
