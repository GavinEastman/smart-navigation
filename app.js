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
  locations: [],          // shared location list (with devices + contacts)
  locById: new Map(),
  locLoaded: false,
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
  const box = $('sheet').querySelector('.sheet-box');
  box.style.transition = ''; box.style.transform = ''; box.scrollTop = 0;
  $('sheet').classList.remove('hidden', 'closing');
  if (mount) mount($('sheetBody'));
}
function closeSheet() {
  const sh = $('sheet'), box = sh.querySelector('.sheet-box');
  if (sh.classList.contains('hidden')) return;
  box.style.transition = 'transform .22s ease'; box.style.transform = 'translateY(100%)';
  sh.classList.add('closing');
  setTimeout(() => {
    sh.classList.add('hidden'); sh.classList.remove('closing');
    box.style.transition = ''; box.style.transform = '';
    $('sheetBody').innerHTML = '';
  }, 220);
}

// Grab the handle at the top of any pop-up and pull it down to close it
function initSheetDrag() {
  const grab = $('sheetGrab'), box = $('sheet').querySelector('.sheet-box');
  let startY = null, lastY = 0, lastT = 0, vel = 0, id = null;
  grab.addEventListener('pointerdown', (e) => {
    startY = e.clientY; lastY = e.clientY; lastT = performance.now(); vel = 0; id = e.pointerId;
    box.style.transition = 'none';
    try { grab.setPointerCapture(id); } catch (err) { /* */ }
  });
  grab.addEventListener('pointermove', (e) => {
    if (startY == null || e.pointerId !== id) return;
    const dy = Math.max(0, e.clientY - startY);
    const now = performance.now(); vel = (e.clientY - lastY) / Math.max(1, now - lastT); lastY = e.clientY; lastT = now;
    box.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (startY == null || (e && e.pointerId !== id)) return;
    const dy = Math.max(0, lastY - startY);
    startY = null;
    if (dy > 90 || vel > 0.6) closeSheet();
    else { box.style.transition = 'transform .2s ease'; box.style.transform = ''; }
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// ======================================================================
// Views
// ======================================================================
const VIEWS = { login: 'vLogin', routes: 'vRoutes', route: 'vRoute', settings: 'vSettings', team: 'vTeam', location: 'vLocation', locedit: 'vLocEdit' };
let currentView = 'login';
function show(name) {
  Object.values(VIEWS).forEach((id) => $(id).classList.add('hidden'));
  $(VIEWS[name]).classList.remove('hidden');
  currentView = name;
  window.scrollTo(0, 0);
  if (name === 'routes') { loadRoutes(); if (!S.locLoaded) loadLocations(); }
  if (name === 'login') startLoginBackground();
  if (name === 'settings') renderSettings();
  if (name === 'team') loadTeam();
  if (name === 'route' && map) setTimeout(() => map.invalidateSize(), 50);
}

// ======================================================================
// Auth
// ======================================================================
async function initAuth() {
  if (!CONFIGURED) { $('setupWarn').classList.remove('hidden'); show('login'); return; }
  // The saved sign-in is read straight from the phone/browser, so this is instant —
  // signed-in people go straight to My Routes and never see the sign-in screen.
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((evt, session) => {
    S.session = session;
    if (!session && currentView !== 'login') { show('login'); }
  });
  show(S.session ? 'routes' : 'login');
  document.body.classList.remove('booting');
  if (S.session) {
    // In the background: make sure the account still exists (removed accounts are signed out)
    sb.auth.getUser().then(async ({ error }) => {
      if (error && /not found|invalid|expired|jwt|does not exist/i.test(error.message || '')) {
        await sb.auth.signOut(); S.session = null; show('login'); toast('Please sign in again.');
      }
    });
  }
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
  // Portal: a ring opens into the map, then My Routes appears underneath
  await playFx('portal', { ms: 1300, cover: true, midway: 0.75, onMidway: () => show('routes') });
  if (currentView !== 'routes') show('routes');
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
    .select('*,stops(status)')   // '*' so the list still loads even if an update script hasn't been run yet
    .order('route_date', { ascending: false }).order('created_at', { ascending: false });
  if (dbErr(error, 'Loading routes')) return;
  S.routes = data || [];
  renderRoutes();
  checkDatabase();
}

// Warn (instead of silently failing) if one of the Supabase update scripts hasn't been run
let dbChecked = false;
async function checkDatabase() {
  if (dbChecked) return;
  dbChecked = true;
  const missing = [];
  const t = async (table, cols, file) => {
    const { error } = await sb.from(table).select(cols).limit(1);
    if (error && /column|does not exist|schema cache/i.test(error.message || '')) missing.push(file);
  };
  await t('locations', 'id', '002_locations.sql');
  await t('routes', 'started_at,completed_at', '003_start_route.sql');
  await t('stops', 'hours_answer', '004_hours_answer.sql');
  const el = $('dbWarn');
  if (!missing.length) { el.classList.add('hidden'); return; }
  el.innerHTML = `⚠️ <b>Database update needed.</b> In Supabase → SQL Editor, run: ${missing.map((f) => `<code>${f}</code>`).join(', ')}. Until then, starting, completing and saving routes won't work properly.`;
  el.classList.remove('hidden');
}

function routeCard(r) {
  const total = r.stops.length, done = r.stops.filter((s) => s.status !== 'pending').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bits = [`${total} stop${total === 1 ? '' : 's'}`];
  if (r.total_distance) bits.push(SN.fmtMiles(r.total_distance));
  if (r.total_drive) bits.push(SN.fmtDur(r.total_drive) + ' driving');
  let badge;
  if (r.completed_at) badge = `<span class="tag done">✔ Completed</span>`;
  else if (r.started_at) badge = `<span class="tag key">▶ In progress · since ${SN.fmtClock(new Date(r.started_at))}</span>`;
  else badge = `<span class="tag">Planned${r.start_time ? ' · ' + SN.fmtClock(new Date(`2000-01-01T${r.start_time}`)) : ''}</span>`;
  const nc = r.completed_at ? '' : `<div class="nc-banner">⚠️ NOT COMPLETED · ${r.started_at ? 'in progress since ' + SN.fmtClock(new Date(r.started_at)) : 'not started yet'}<span>Tap to continue, then ✔ Complete it — or 🗑 delete it</span></div>`;
  return `<div class="route-card ${r.completed_at ? '' : 'current'}" data-id="${r.id}">
    ${nc}
    <div class="row between"><div class="name">${esc(r.name)}</div>
      <div class="row gap6"><span class="tag">${esc(fmtDate(r.route_date))}</span>
      <button class="trash-btn" data-del="${r.id}" aria-label="Delete route">🗑</button></div></div>
    <div class="meta">${bits.join(' · ')}${total ? ` · ${done}/${total} done` : ''}</div>
    <div class="row between mt-s">${badge}${r.completed_at ? '' : '<span class="go">Continue ›</span>'}</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
  </div>`;
}

function renderRoutes() {
  // Top: routes that aren't finished yet (always kept, so you can pick up where you left off).
  // Below: only routes that were completed AND saved. ("Don't save" deletes them.)
  const current = S.routes.filter((r) => !r.completed_at)
    .sort((a, b) => (b.started_at ? 1 : 0) - (a.started_at ? 1 : 0) || String(b.route_date).localeCompare(a.route_date));
  const saved = S.routes.filter((r) => r.completed_at)
    .sort((a, b) => String(b.completed_at).localeCompare(a.completed_at));
  $('routesEmpty').classList.toggle('hidden', S.routes.length > 0);
  $('routesList').innerHTML =
    (current.length ? `<div class="nc-alert">⚠️ You have ${current.length} route${current.length > 1 ? 's' : ''} not completed</div>
      <div class="sec-title">Not completed</div>${current.map(routeCard).join('')}` : '')
    + (saved.length ? `<div class="sec-title">Saved routes</div>${saved.map(routeCard).join('')}` : '');
}

function confirmDeleteRoute(id) {
  const r = S.routes.find((x) => x.id === id);
  if (!r) return;
  openSheet(`<h2>Delete route?</h2>
    <div class="sub">Do you want to delete <b>“${esc(r.name)}”</b> (${esc(fmtDate(r.route_date))}, ${r.stops.length} stop${r.stops.length === 1 ? '' : 's'})? This can't be undone.</div>
    <div class="actions" style="grid-template-columns:1fr 1fr">
      <button class="btn secondary big" id="drNo">No</button>
      <button class="btn danger big" id="drYes">Yes, delete</button>
    </div>`, (el) => {
    el.querySelector('#drNo').onclick = closeSheet;
    el.querySelector('#drYes').onclick = async () => {
      const { error } = await sb.from('routes').delete().eq('id', id);
      if (dbErr(error, 'Delete')) return;
      closeSheet();
      S.routes = S.routes.filter((x) => x.id !== id);
      renderRoutes();
      toast(`Deleted “${r.name}”`);
    };
  });
}

function defaultStartTime() {
  return '08:00'; // the shop's normal morning start
}

/** New route pop-up = route settings, filled in before anything else. */
function newRoute(after) {
  let collectors = 2, nameEdited = false;
  const autoName = (d) => `Route – ${fmtDate(d)}`;
  openSheet(`<h2>New route</h2>
    <div class="sub">Set up your route before adding stops. You can change these later with ☰.</div>
    <label class="lbl" for="nrName">Route name</label>
    <input id="nrName" type="text" value="${esc(autoName(todayISO()))}">
    <div class="row gap6">
      <div style="flex:1"><label class="lbl" for="nrDate">Date</label><input id="nrDate" type="date" value="${todayISO()}"></div>
      <div style="flex:1"><label class="lbl" for="nrTime">Start time</label><input id="nrTime" type="time" value="${defaultStartTime()}"></div>
    </div>
    <div class="lbl">How many collectors are on route today?</div>
    ${seg('nrCollectors', [[1, '1'], [2, '2'], [3, '3']], 2)}
    <div class="lbl">Start &amp; finish</div>
    <div class="est"><span>🏠 ${esc(CFG.SHOP_NAME || 'Shop')}<br><small class="hint">${esc(CFG.SHOP_ADDRESS || '')}</small></span></div>
    <div class="hint">Tap <b>▶ Start route</b> when you actually leave the shop — times will adjust from then.</div>
    <button class="btn primary block big mt" id="nrCreate">Create route</button>
    <button class="btn secondary block mt" id="nrCancel">Cancel</button>`, (el) => {
    const nameEl = el.querySelector('#nrName'), dateEl = el.querySelector('#nrDate');
    nameEl.oninput = () => { nameEdited = true; };
    dateEl.onchange = () => { if (!nameEdited) nameEl.value = autoName(dateEl.value || todayISO()); };
    el.querySelector('#nrCancel').onclick = closeSheet;
    el.querySelector('[data-seg="nrCollectors"]').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      el.querySelectorAll('[data-seg="nrCollectors"] button').forEach((x) => x.classList.toggle('on', x === b));
      collectors = +b.dataset.v;
    };
    el.querySelector('#nrCreate').onclick = async () => {
      const d = dateEl.value || todayISO();
      const t = el.querySelector('#nrTime').value || null;
      const name = nameEl.value.trim() || autoName(d);
      if (!t) { toast('Pick a start time.'); return; }
      closeSheet();
      const { data, error } = await sb.from('routes')
        .insert({ name, route_date: d, collectors, start_time: t }).select('*').single();
      if (dbErr(error, 'Creating route')) return;
      await openRoute(data.id);
      if (typeof after === 'function') after();
    };
  });
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
  if (!S.locLoaded) await loadLocations();
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
      const loc = locOf(s);
      const g = loc && loc.lat != null ? { lat: loc.lat, lng: loc.lng } : await geocode(s.address);
      if (g) {
        await updateStop(s, { lat: g.lat, lng: g.lng });
        if (loc && loc.lat == null) saveLocCoords(loc, g);
      }
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
    if (s.location_id) { r.location_id = s.location_id; r.rt_tasks = s.rt_tasks || []; }
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
    const locHits = matchLocations(q).slice(0, 5);
    let hits = [];
    try { hits = await photonSearch(q, locHits.length ? 4 : 6); } catch (e) { /* offline */ }
    if (seq !== searchSeq) return;
    searchHits = hits;
    const box = $('searchResults');
    box.innerHTML = locHits.map((l) => `<div class="sr" data-loc="${esc(l.id)}"><div class="t">📍 ${esc(l.name)}</div><div class="d">${esc(locAddress(l))}</div></div>`).join('')
      + hits.map((h, i) => `<div class="sr" data-i="${i}"><div class="t">${esc(h.name || h.address.split(',')[0])}</div><div class="d">${esc(h.address)}</div></div>`).join('')
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
    const line = r.geometry.coordinates.filter((_, i, a) => a.length < 900 || i % 3 === 0 || i === a.length - 1).map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]);
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

// ---------- Service time & business hours for a stop ----------
function locOf(stop) { return stop && stop.location_id ? S.locById.get(stop.location_id) || null : null; }
function rtCountOf(loc) { return (loc.devices || []).filter((d) => /redemption/i.test(d.category)).length; }
function gameCountOf(loc) { return (loc.devices || []).filter((d) => /skill/i.test(d.category)).length; }
// Skill games: an entered number wins; otherwise the machines on the equipment list count automatically.
function gamesOf(loc) { return loc.games_confirmed != null ? loc.games_confirmed : gameCountOf(loc); }
// ACH: most locations are ACH, so anything not marked Non-ACH counts as ACH.
function achOf(loc) { return loc.ach !== false; }

/** { minutes, missing[], tasks[] } — location stops use the strict rules; other stops use "minutes on site". */
function svcOf(stop) {
  const loc = locOf(stop);
  const collectors = (S.route && S.route.collectors) || 1;
  if (!loc) return { minutes: Number(stop.service_override) || 0, missing: [], tasks: [] };
  return SN.locationService({
    games: gamesOf(loc), ach: achOf(loc), payout: loc.payout_tickets,
    rtCount: rtCountOf(loc), rtTasks: stop.rt_tasks || [],
  }, collectors);
}

function routeDayStart() {
  const [y, m, d] = String(S.route.route_date || todayISO()).split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** When the truck leaves the shop: start time if set, otherwise now (today) or 7:00 AM (other days). */
function departure() {
  const r = S.route, day = routeDayStart();
  if (r.started_at) {
    // Route already started: plan remaining stops from now (when re-optimizing) — ETAs use started_at
    const started = new Date(r.started_at);
    return S.stops.some(isFinished) ? new Date(Math.max(Date.now(), started.getTime())) : started;
  }
  if (r.start_time) { const [h, mi] = r.start_time.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi); }
  if (r.route_date === todayISO()) return new Date();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 7, 0);
}

/** Opening windows for a stop on the route day. Bypasses: stop "ignore hours today" or location "access anytime". */
function winOf(stop) {
  const loc = locOf(stop);
  if (!loc || stop.ignore_hours || loc.access_anytime) return { anytime: true };
  return SN.openWindows(loc.hours, loc.hours_comment, loc.open_24_7, routeDayStart());
}

/** Is this saved location closed at the route's start time? Returns null if open/always open/unknown hours,
 *  otherwise { opensAt: Date|null } (null = closed the rest of the day). Uses the location's own hours. */
function closedAtStart(loc) {
  if (!loc || loc.access_anytime) return null;
  const w = SN.openWindows(loc.hours, loc.hours_comment, loc.open_24_7, routeDayStart());
  if (w.anytime || w.unknown || w.unknownHours) return null;   // 24/7 or no hours on file = get in any time
  const t = departure().getTime();
  if (w.windows.some(([a, b]) => t >= a && t < b)) return null;
  const dayEnd = routeDayStart().getTime() + 86400000;
  const next = w.windows.find(([a]) => a > t && a < dayEnd);
  return { opensAt: next ? new Date(next[0]) : null };
}
/** Stops that need the "can you get in early?" question answered before Optimize. */
function needsHoursAnswer(s) {
  return !isFinished(s) && !s.hours_answer && !!closedAtStart(locOf(s));
}
function closedText(c) { return c.opensAt ? `Not open yet — opens ${SN.fmtClock(c.opensAt)}` : 'Closed the rest of the day'; }

async function answerHours(s, early) {
  await updateStop(s, { hours_answer: early ? 'early' : 'wait', ignore_hours: !!early });
  renderRoute();
}

function showHoursQuestions(then) {
  const list = S.stops.filter(needsHoursAnswer);
  if (!list.length) { closeSheet(); if (then) then(); return; }
  openSheet(`<h2>⚠️ Attention needed</h2>
    <div class="sub">${list.length === 1 ? 'This location isn\'t' : 'These locations aren\'t'} open at your start time (${esc(SN.fmtClock(departure()))}). Can you get in early — key, door code, or the owner letting you in?</div>
    ${list.map((s) => { const c = closedAtStart(locOf(s)); return `<div class="card attn-card">
      <div class="strong">${esc(s.name || s.address)}</div>
      <div class="hint">${esc(closedText(c))}</div>
      <div class="actions" style="grid-template-columns:1fr 1fr">
        <button class="btn ok" data-early="${s.id}">🔑 Yes, we can get in</button>
        <button class="btn secondary" data-wait="${s.id}">⏰ No, wait till open</button>
      </div></div>`; }).join('')}
    <button class="btn secondary block" id="hqClose">Cancel</button>`, (el) => {
    el.querySelector('#hqClose').onclick = closeSheet;
    el.querySelectorAll('[data-early],[data-wait]').forEach((b) => b.onclick = async () => {
      const s = S.stops.find((x) => x.id === (b.dataset.early || b.dataset.wait));
      if (!s) return;
      await answerHours(s, !!b.dataset.early);
      showHoursQuestions(then);   // next question, or carry on when all answered
    });
  });
}

function unschedReason() { return "Closed, or can't finish before closing"; }

// ---------- Optimize ----------
function blockingProblems(stops) {
  return stops.map((s) => ({ s, loc: locOf(s), svc: svcOf(s) })).filter((x) => x.loc && x.svc.missing.length);
}
function showBlocked(list) {
  openSheet(`<h2>Fix these first</h2>
    <div class="sub">Service time can't be calculated until these settings are confirmed on the location. Unknown settings block Optimize.</div>
    ${list.map(({ s, loc, svc }) => `<div class="card"><div class="strong">${esc(loc.name)}</div>
      <div class="hint">${svc.missing.map(esc).join(' · ')}</div>
      <button class="btn secondary sm mt" data-fixloc="${esc(loc.id)}">Open location →</button></div>`).join('')}
    <button class="btn secondary block" id="blkClose">Close</button>`, (el) => {
    el.querySelector('#blkClose').onclick = closeSheet;
    el.querySelectorAll('[data-fixloc]').forEach((b) => b.onclick = () => { closeSheet(); openLocation(b.dataset.fixloc, 'route'); });
  });
}

async function optimize(keepOrder = false) {
  const pending = S.stops.filter((s) => !isFinished(s) && located(s));
  if (!pending.length) { toast('No remaining stops with a found address.'); return; }
  const blocked = blockingProblems(pending);
  if (blocked.length) { showBlocked(blocked); return; }
  if (pending.some(needsHoursAnswer)) { showHoursQuestions(() => optimize(keepOrder)); return; }
  showLoader(keepOrder ? 'Updating your times…' : 'Finding the best route…');
  try {
    const shop = await getShop();
    if (!shop) { toast("Couldn't find the shop address. Check your connection, or set SHOP_LAT/SHOP_LNG in config.js."); return; }
    const start = { ...shop, kind: 'shop' };
    const dep = departure();

    let ordered = pending, unsched = [];
    if (!keepOrder) {
      const pts = [start, ...pending];
      const m = await osrmTable(pts);
      const info = pending.map((s) => ({ win: winOf(s), svcMin: svcOf(s).minutes }));
      const plan = SN.scheduleRoute(m, info, dep.getTime());
      ordered = plan.order.map((i) => pending[i - 1]);
      unsched = plan.unscheduled.map((i) => pending[i - 1]);
    }

    const finished = S.stops.filter(isFinished);
    const unlocated = S.stops.filter((s) => !isFinished(s) && !located(s));
    S.stops = [...finished, ...ordered, ...unsched, ...unlocated];
    await savePositions();

    const routePts = [start, ...ordered, start];
    const geo = ordered.length ? await osrmRoute(routePts) : null;
    const legs = {
      start: { lat: start.lat, lng: start.lng, kind: 'shop' },
      items: ordered.map((s, i) => ({ id: s.id, s: geo ? geo.legs[i].s : null, m: geo ? geo.legs[i].m : null })),
      back: geo ? geo.legs[geo.legs.length - 1] : null,
      unscheduled: unsched.map((s) => ({ id: s.id, reason: unschedReason(winOf(s)) })),
      dep: dep.toISOString(),
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
    if (unsched.length) toast(`${unsched.length} stop${unsched.length > 1 ? 's' : ''} couldn't fit in business hours — see the bottom of the list.`, 5000);
    else toast(keepOrder ? 'Times updated ✔' : 'Route optimized ✔');
  } finally { await hideLoader(); }
}

/** ETAs, waits and warnings. Valid only while the stop order matches the last calculation.
 *  Once a stop is marked done, later ETAs are recalculated from the time it was actually finished. */
function computePlan() {
  const r = S.route, legs = r.legs;
  const serviceTotal = S.stops.filter((s) => !isFinished(s)).reduce((a, s) => a + svcOf(s).minutes, 0);
  const plan = { valid: false, eta: {}, wait: {}, late: {}, unsched: {}, serviceTotal, finish: null };
  if (!legs || !legs.items) return plan;
  (legs.unscheduled || []).forEach((u) => { plan.unsched[u.id] = u.reason; });
  const ids = legs.items.map((x) => x.id);
  const known = new Set([...ids, ...Object.keys(plan.unsched)]);
  const inOrder = S.stops.filter((s) => ids.includes(s.id)).map((s) => s.id);
  const pendingLocated = S.stops.filter((s) => !isFinished(s) && located(s)).map((s) => s.id);
  if (inOrder.join() !== ids.join() || pendingLocated.some((id) => !known.has(id))) return plan;
  if (legs.items.some((x) => x.s == null)) return plan;

  // Start of the day: actual start (▶ Start route) > planned start time > when it was optimized
  let clock = r.started_at ? new Date(r.started_at) : r.start_time ? departure() : new Date(legs.dep || legs.at || r.optimized_at);
  const byId = Object.fromEntries(S.stops.map((s) => [s.id, s]));
  for (const it of legs.items) {
    const st = byId[it.id];
    if (isFinished(st)) { if (st.completed_at) clock = new Date(st.completed_at); continue; }
    const arrive = clock.getTime() + it.s * 1000;
    const svcMs = svcOf(st).minutes * 60000;
    let start = SN.earliestStart(winOf(st), arrive, svcMs);
    if (start == null) { plan.late[st.id] = true; start = arrive; }
    plan.eta[st.id] = new Date(arrive);
    if (start > arrive + 60000) plan.wait[st.id] = new Date(start);
    clock = new Date(start + svcMs);
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
  if (r.geometry && r.geometry.length > 1) L.polyline(r.geometry, { color: '#8ebe42', weight: 6, opacity: 0.95 }).addTo(mapLayer);
  if (r.geometry && r.geometry.length > 1) L.polyline(r.geometry, { color: '#054c88', weight: 2, opacity: 0.9 }).addTo(mapLayer);
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
const ACCESS_LABEL = { key: '🔑 Key', code: '🔢 Door code', call: '📞 Call owner', '': '🔑 Access anytime' };

function stopExtras(s) {
  const loc = locOf(s), out = [];
  const svc = svcOf(s);
  if (loc) {
    const g = gamesOf(loc), rt = rtCountOf(loc);
    out.push(`🎰 ${g}`);
    if (rt) out.push(`RT ×${rt} (${svc.tasks.join(', ')})`);
    out.push(achOf(loc) ? 'ACH' : 'Non-ACH');
    if (loc.access_anytime) out.push(ACCESS_LABEL[loc.access_method || '']);
    if (s.ignore_hours) out.push('⏰ hours ignored today');
  }
  if (!svc.missing.length && svc.minutes) out.push(`⏱ ${svc.minutes} min`);
  return { text: out.map(esc).join(' · '), missing: svc.missing };
}

function renderRoute(fit = false) {
  const r = S.route;
  if (!r) return;
  $('routeName').textContent = r.name;
  $('routeDate').textContent = r.name.includes(fmtDate(r.route_date)) ? '' : fmtDate(r.route_date);
  const plan = computePlan();
  const total = S.stops.length, done = S.stops.filter(isFinished).length;

  const drive = plan.valid && r.total_drive ? SN.fmtDur(r.total_drive) : '—';
  const miles = plan.valid && r.total_distance ? SN.fmtMiles(r.total_distance) : '—';
  $('summary').innerHTML = `
    <div class="s"><div class="v">${done}/${total}</div><div class="k">Stops</div></div>
    <div class="s"><div class="v">${miles}</div><div class="k">Distance</div></div>
    <div class="s"><div class="v">${drive}</div><div class="k">Drive</div></div>
    <div class="s"><div class="v">${plan.valid ? SN.fmtClock(plan.finish) : SN.fmtDur(plan.serviceTotal * 60)}</div><div class="k">${plan.valid ? 'Back at shop' : 'Service'}</div></div>`;

  renderStartBar(plan);
  $('vRoute').classList.toggle('readonly', !!r.completed_at); // completed routes are view-only
  $('btnKeepOrder').classList.toggle('hidden', total < 1);
  const blocked = blockingProblems(S.stops.filter((s) => !isFinished(s)));
  let head = total ? `${total} stop${total > 1 ? 's' : ''} · ${r.collectors} collector${r.collectors > 1 ? 's' : ''} · leave ${SN.fmtClock(departure())}` : 'No stops yet — search above or add from locations';
  if (blocked.length) head += ` · ⚠️ ${blocked.length} need settings`;
  const attn = S.stops.filter(needsHoursAnswer).length;
  if (attn) head += ` · ⚠️ ${attn} need attention`;
  else if (total && !plan.valid && S.stops.some((s) => !isFinished(s) && located(s))) head += ' · tap Optimize to plan';
  $('stopCount').textContent = head;

  // Next stop card
  const next = S.stops.find((s) => !isFinished(s) && located(s) && !plan.unsched[s.id]);
  const nc = $('nextCard');
  if (next && plan.valid && plan.eta[next.id]) {
    const idx = S.stops.indexOf(next) + 1;
    const svc = svcOf(next);
    const w = plan.wait[next.id];
    nc.innerHTML = `<div class="lab">NEXT STOP · #${idx}</div>
      <div class="nm">${esc(next.name || next.address.split(',')[0])}</div>
      <div class="ad">${esc(next.address)}</div>
      <div class="eta">ETA ${SN.fmtClock(plan.eta[next.id])}${w ? ` · opens ${SN.fmtClock(w)}` : ''}${plan.late[next.id] ? ' · ⚠️ outside business hours' : ''} · ${svc.minutes} min on site</div>
      <div class="row">
        <a class="btn lime" href="${navUrl(next)}" target="_blank" rel="noopener">➤ Navigate</a>
        <button class="btn secondary" data-done="${next.id}">✔ Done</button>
        <button class="btn secondary" data-open="${next.id}">Details</button>
      </div>`;
    nc.classList.remove('hidden');
  } else nc.classList.add('hidden');

  // Stop list
  $('stopList').innerHTML = S.stops.map((s, i) => {
    const cls = ['stop', s === next ? 'next' : '', s.status, needsHoursAnswer(s) ? 'needs-attn' : ''].join(' ');
    const ex = stopExtras(s);
    let side = '';
    if (!isFinished(s)) {
      if (plan.unsched[s.id]) side = `<span class="tag failed">Not scheduled</span>`;
      else if (plan.valid && plan.eta[s.id]) side = `<div class="t">${SN.fmtClock(plan.eta[s.id])}</div>${plan.wait[s.id] ? `<div>opens ${SN.fmtClock(plan.wait[s.id])}</div>` : ''}${plan.late[s.id] ? '<span class="tag warn">Hours</span>' : ''}`;
    } else {
      side = s.status === 'done' ? '<span class="tag done">Done</span>' : s.status === 'failed' ? '<span class="tag failed">Failed</span>' : '<span class="tag">Skipped</span>';
    }
    const bad = !located(s) ? (S.geoFailed.has(s.id) ? '<div class="bad">Address not found — tap to fix</div>' : '<div class="bad">Finding address…</div>') : '';
    const warn = ex.missing.length ? `<div class="bad">⚠️ ${ex.missing.map(esc).join(' · ')}</div>` : '';
    const why = plan.unsched[s.id] && !isFinished(s) ? `<div class="bad">${esc(plan.unsched[s.id])} — tap to bypass hours</div>` : '';
    const cl = needsHoursAnswer(s) ? closedAtStart(locOf(s)) : null;
    const attnB = cl ? `<div class="attn">⚠️ ATTENTION NEEDED · ${esc(closedText(cl))}. Can you get in early? Tap to answer.</div>` : '';
    return `<li class="${cls}" data-open="${s.id}">
      <div class="num">${i + 1}</div>
      <div class="body">
        ${s.name ? `<div class="nm">${esc(s.name)}</div>` : ''}
        <div class="ad">${esc(s.address)}</div>
        ${ex.text ? `<div class="ex">${ex.text}</div>` : ''}
        ${s.notes ? `<div class="ex">📝 ${esc(s.notes.slice(0, 60))}${s.notes.length > 60 ? '…' : ''}</div>` : ''}
        ${attnB}${bad}${warn}${why}
      </div>
      <div class="side">${side}</div>
    </li>`;
  }).join('');
  drawMap(fit);
}

// ---------- Start time & ▶ Start route ----------
function renderStartBar() {
  const r = S.route, bar = $('startBar');
  if (r.completed_at) {
    bar.innerHTML = `<div class="sb-text">✔ <b>Completed</b> ${esc(new Date(r.completed_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}<div class="hint">Saved route. Use ☰ → Duplicate to run it again.</div></div>
      <button class="btn secondary sm" id="sbReopen">Reopen</button>`;
  } else if (r.started_at) {
    bar.innerHTML = `<div class="sb-text">▶ <b>Started ${SN.fmtClock(new Date(r.started_at))}</b><div class="hint">Times are from when you actually left.</div></div>
      <button class="btn secondary sm" id="sbUndo">Undo start</button>
      <button class="btn ok sm" id="sbComplete">✔ Complete</button>`;
  } else {
    bar.innerHTML = `<div class="sb-text">🕗 Planned start <b>${SN.fmtClock(departure())}</b><div class="hint">${esc(fmtDate(r.route_date))}</div></div>
      <button class="btn secondary sm" id="sbChange">Change</button>
      <button class="btn lime sm" id="sbStart">▶ Start route</button>`;
  }
  const ch = $('sbChange'), st = $('sbStart'), un = $('sbUndo');
  if (ch) ch.onclick = openStartTime;
  if (st) st.onclick = startRoute;
  if (un) un.onclick = (e) => twoTap(e.currentTarget, async () => { await updateRoute({ started_at: null }); renderRoute(); toast('Start undone'); });
  const cp = $('sbComplete'), ro = $('sbReopen');
  if (cp) cp.onclick = openComplete;
  if (ro) ro.onclick = async () => { await updateRoute({ completed_at: null }); renderRoute(); toast('Route reopened'); };
}

function openStartTime() {
  const r = S.route;
  openSheet(`<h2>Start time</h2><div class="sub">When do you plan to leave the shop?</div>
    <label class="lbl" for="stTime">Start time</label><input id="stTime" type="time" value="${esc((r.start_time || defaultStartTime()).slice(0, 5))}">
    <label class="lbl" for="stDate">Date</label><input id="stDate" type="date" value="${esc(r.route_date)}">
    <button class="btn primary block mt" id="stTimeSave">Save</button>
    <button class="btn secondary block mt" id="stTimeCancel">Cancel</button>`, (el) => {
    el.querySelector('#stTimeCancel').onclick = closeSheet;
    el.querySelector('#stTimeSave').onclick = async () => {
      const t = el.querySelector('#stTime').value, d = el.querySelector('#stDate').value || r.route_date;
      if (!t) { toast('Pick a start time.'); return; }
      const dateChanged = d !== r.route_date;
      await updateRoute({ start_time: t, route_date: d });
      closeSheet(); renderRoute();
      // Hours depend on the start time/day, so re-plan if a plan exists
      if (r.legs && S.stops.some((s) => !isFinished(s) && located(s))) {
        toast(dateChanged ? 'Date changed — re-planning for that day…' : 'Start time changed — updating the plan…');
        optimize(false);
      } else toast('Start time saved');
    };
  });
}

function openComplete() {
  const r = S.route;
  const total = S.stops.length, done = S.stops.filter((s) => s.status === 'done').length;
  const left = S.stops.filter((s) => s.status === 'pending').length;
  openSheet(`<h2>Complete route</h2>
    <div class="sub">${done} of ${total} stops done${r.started_at ? ` · started ${SN.fmtClock(new Date(r.started_at))}, finished ${SN.fmtClock(new Date())}` : ''}.</div>
    ${left ? `<div class="warn-box">${left} stop${left > 1 ? 's are' : ' is'} still not marked done.</div>` : ''}
    <button class="btn primary block big" id="cpSave">💾 Save route</button>
    <div class="hint">Saved routes stay in <b>My Routes</b> so you can look back at them or duplicate them later.</div>
    <button class="btn danger block mt" id="cpDiscard">🗑 Don't save</button>
    <div class="hint">Deletes this route and its stops forever. It can't be undone.</div>
    <button class="btn secondary block mt" id="cpCancel">Cancel — keep working</button>`, (el) => {
    el.querySelector('#cpCancel').onclick = closeSheet;
    el.querySelector('#cpSave').onclick = async () => {
      await updateRoute({ completed_at: new Date().toISOString() });
      closeSheet();
      await playFx('complete', { ms: 2900, text: 'Route complete!', tapSkip: true, dim: true });
      S.route = null; show('routes'); toast('Route completed and saved ✔');
    };
    el.querySelector('#cpDiscard').onclick = (e) => twoTap(e.currentTarget, async () => {
      const { error } = await sb.from('routes').delete().eq('id', r.id);
      if (dbErr(error, 'Delete')) return;
      closeSheet(); S.route = null; S.stops = []; show('routes'); toast('Route completed — not saved');
    }, 'Tap again — delete forever');
  });
}

async function startRoute() {
  const r = S.route;
  if (!S.stops.some((s) => !isFinished(s))) { toast('Add some stops first.'); return; }
  if (r.route_date !== todayISO()) await updateRoute({ route_date: todayISO() });
  await updateRoute({ started_at: new Date().toISOString() });
  renderRoute();
  const plan = computePlan();
  if (!plan.valid && S.stops.some((s) => !isFinished(s) && located(s))) {
    toast('Route started — planning from now…');
    await optimize(false);
  } else {
    // Re-check hours with the real start time; re-plan only if something no longer fits
    if (Object.keys(plan.late).length) { toast('Route started — some times moved, re-planning…'); await optimize(false); }
    else toast('Route started ✔ Times updated from now.');
  }
}

// ---------- Press-and-hold to drag stops up/down the list ----------
// Hold a stop ~0.4 s (finger or mouse), then move it. "Move → position" in the stop sheet still works too.
const DRAG = { timer: null, active: false, li: null, ghost: null, startY: 0, offsetY: 0, pointerId: null, justDropped: false, scrollT: null };

function dragCancelPending() { clearTimeout(DRAG.timer); DRAG.timer = null; }

function initStopDrag() {
  const list = $('stopList');
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (S.route && S.route.completed_at) return;              // saved routes are view-only
    const li = e.target.closest('li.stop');
    if (!li || e.target.closest('a,button,input')) return;
    DRAG.startY = e.clientY; DRAG.startX = e.clientX; DRAG.pointerId = e.pointerId;
    dragCancelPending();
    DRAG.timer = setTimeout(() => dragStart(li, e.clientY), 400);
  });
  // moving before the hold finishes = normal scrolling, not a drag
  document.addEventListener('pointermove', (e) => {
    if (DRAG.timer && (Math.abs(e.clientY - DRAG.startY) > 8 || Math.abs(e.clientX - DRAG.startX) > 8)) dragCancelPending();
    if (DRAG.active && e.pointerId === DRAG.pointerId) { e.preventDefault(); dragMove(e.clientY); }
  }, { passive: false });
  const end = (e) => { dragCancelPending(); if (DRAG.active && (!e || e.pointerId === DRAG.pointerId)) dragEnd(); };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // stop the page from scrolling while a stop is being dragged (phones)
  document.addEventListener('touchmove', (e) => { if (DRAG.active || DRAG.timer) { if (DRAG.active) e.preventDefault(); } }, { passive: false });
  list.addEventListener('contextmenu', (e) => { if (e.target.closest('li.stop')) e.preventDefault(); });
}

function dragStart(li, y) {
  DRAG.timer = null; DRAG.active = true; DRAG.li = li;
  const r = li.getBoundingClientRect();
  DRAG.offsetY = y - r.top;
  const ghost = li.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = r.width + 'px'; ghost.style.left = r.left + 'px'; ghost.style.top = r.top + 'px';
  document.body.appendChild(ghost);
  DRAG.ghost = ghost;
  li.classList.add('drag-placeholder');
  li.style.height = r.height + 'px';
  document.body.classList.add('dragging');
  try { navigator.vibrate && navigator.vibrate(15); } catch (e) { /* */ }
}

function dragMove(y) {
  DRAG.ghost.style.top = (y - DRAG.offsetY) + 'px';
  // where should the placeholder go?
  const list = $('stopList');
  const items = [...list.children].filter((x) => x !== DRAG.li);
  let before = null;
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = it; break; }
  }
  if (before) { if (DRAG.li.nextSibling !== before) list.insertBefore(DRAG.li, before); }
  else if (list.lastElementChild !== DRAG.li) list.appendChild(DRAG.li);
  // auto-scroll near the screen edges
  clearInterval(DRAG.scrollT);
  const edge = 70, vh = window.innerHeight;
  const moved = Math.abs(y - DRAG.startY) > 24; // don't scroll the moment a stop near the edge is picked up
  const dir = !moved ? 0 : y < edge ? -1 : y > vh - edge ? 1 : 0;
  if (dir) DRAG.scrollT = setInterval(() => { window.scrollBy(0, dir * 12); }, 16);
}

async function dragEnd() {
  clearInterval(DRAG.scrollT);
  DRAG.active = false;
  document.body.classList.remove('dragging');
  if (DRAG.ghost) DRAG.ghost.remove();
  const li = DRAG.li;
  li.classList.remove('drag-placeholder'); li.style.height = '';
  DRAG.justDropped = true; setTimeout(() => { DRAG.justDropped = false; }, 350);
  const ids = [...$('stopList').children].map((x) => x.dataset.open);
  const before = S.stops.map((s) => s.id);
  if (ids.join() === before.join()) { renderRoute(); return; }
  const byId = Object.fromEntries(S.stops.map((s) => [s.id, s]));
  S.stops = ids.map((id) => byId[id]).filter(Boolean);
  renderRoute();
  await savePositions();
  renderRoute();
  toast('Moved ✔ Tap “Keep my order” to update the times.');
}

// ======================================================================
// Stop sheet
// ======================================================================
function seg(name, options, value, disabled = false) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-v="${v}" class="${String(value) === String(v) ? 'on' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
}

function hoursToday(loc, date = new Date()) {
  const key = SN.DAYS[date.getDay()];
  const txt = (loc.hours || {})[key];
  const w = SN.openWindows(loc.hours, loc.hours_comment, loc.open_24_7, new Date(date.getFullYear(), date.getMonth(), date.getDate()));
  let status;
  if (w.unknownHours) status = 'Hours unknown';
  else if (w.anytime) status = 'Open 24/7';
  else if (w.unknown || w.unknownHours) status = 'Hours unknown';
  else status = w.windows.some(([a, b]) => date >= a && date < b) ? 'Open now' : 'Closed now';
  return { txt: txt || '—', status };
}

function openStop(id) {
  const s = S.stops.find((x) => x.id === id);
  if (!s) return;
  const idx = S.stops.indexOf(s) + 1;
  const r = S.route;
  const loc = locOf(s);
  const svc = svcOf(s);
  const plan = computePlan();
  const phone = s.phone || (loc && loc.phone) || '';
  const statusBtns = s.status === 'pending'
    ? `<button class="btn ok" data-st="done">✔ Done</button><button class="btn danger" data-st="failed">✖ Failed</button><button class="btn secondary" data-st="skipped">Skip</button>`
    : `<button class="btn secondary" data-st="pending" style="grid-column: span 3">↺ Mark as not done (${esc(s.status)})</button>`;

  let hoursCard = '', svcCard = '';
  if (loc) {
    const h = hoursToday(loc, routeDayStart().toDateString() === new Date().toDateString() ? new Date() : routeDayStart());
    const rt = rtCountOf(loc);
    const wDay = SN.openWindows(loc.hours, loc.hours_comment, loc.open_24_7, routeDayStart());
    const noHours = !!wDay.unknownHours;                      // nothing on file for that day
    const hoursApply = !loc.access_anytime && !wDay.anytime;  // real hours we have to respect
    const need = needsHoursAnswer(s);
    const cl = hoursApply ? closedAtStart(loc) : null;
    const early = !!s.ignore_hours, waitAns = s.hours_answer === 'wait' && !s.ignore_hours;
    let body;
    if (!hoursApply) {
      body = `<div class="ok-box">${loc.access_anytime ? esc(ACCESS_LABEL[loc.access_method || '']) + ' — this location can be visited any time.'
        : noHours ? 'No hours on file — treated as open 24/7, get in any time.' : 'Open 24/7.'}</div>`;
    } else {
      body = `<div class="${need ? 'attn attn-box' : 'hours-q'}">
        ${need ? '⚠️ <b>Attention needed:</b> ' : ''}${cl ? esc(closedText(cl)) + ` (you start ${esc(SN.fmtClock(departure()))}).` : 'Open at your start time.'}
        ${plan.unsched[s.id] ? `<div><b>Not scheduled:</b> ${esc(plan.unsched[s.id])}.</div>` : ''}
        <div class="q">Can you get in outside business hours today?</div>
        <div class="seg ans-seg">
          <button type="button" data-ans="early" class="${early ? 'on' : ''}">🔑 Yes, we can get in</button>
          <button type="button" data-ans="wait" class="${waitAns ? 'on' : ''}">⏰ No, wait till open</button>
        </div>
        <div class="hint">Key, door code, or the owner letting you in.</div>
      </div>`;
    }
    hoursCard = `<div class="card mt">
      <div class="card-title">Hours</div>
      <div class="row between"><span>${esc(SN.DAYS[routeDayStart().getDay()].replace(/^./, (c) => c.toUpperCase()))}: <b>${esc(noHours ? 'not on file' : h.txt)}</b></span>${noHours ? '' : `<span class="tag">${esc(h.status)}</span>`}</div>
      ${loc.hours_comment ? `<div class="hint">${esc(loc.hours_comment)}</div>` : ''}
      ${body}
    </div>`;
    const gamesTxt = `${gamesOf(loc)}`;
    const tri = (v, y, n) => (v === true ? y : v === false ? n : '<span class="err">Unknown</span>');
    svcCard = `<div class="card">
      <div class="card-title">Service time</div>
      <div class="kv">
        <span class="k">Skill games</span><span>${gamesTxt}</span>
        <span class="k">ACH</span><span>${achOf(loc) ? 'ACH' : 'Non-ACH'}</span>
        <span class="k">Payout tickets</span><span>${rt ? 'No (has RT)' : tri(loc.payout_tickets, 'Yes', 'No')}</span>
        <span class="k">Redemption terminals</span><span>${rt}</span>
      </div>
      ${svc.tasks.map((t, i) => `<div class="lbl">RT ${i + 1} task today</div>${seg('rt' + i, [['None', 'None'], ['Fill', 'Fill'], ['Swap', 'Swap']], t)}`).join('')}
      ${svc.missing.length
        ? `<div class="warn-box">Can't estimate: ${svc.missing.map(esc).join(', ')}. Fix it on the location.</div>`
        : `<div class="est"><span>On site (${r.collectors} collector${r.collectors > 1 ? 's' : ''})</span><b id="estVal">${svc.minutes} min</b></div>`}
      <button class="btn secondary block mt" id="stOpenLoc">📍 Open location profile</button>
    </div>`;
  } else {
    svcCard = `<div class="card mt">
      <div class="card-title">Time on site</div>
      <label class="lbl" for="stMinutes">Minutes</label>
      <input id="stMinutes" type="number" inputmode="numeric" min="0" max="1440" value="${s.service_override ?? 0}">
      <div class="hint">For stops that aren't saved locations (pickups, supply runs…).</div>
    </div>`;
  }

  openSheet(`
    <h2>#${idx} ${esc(s.name || s.address.split(',')[0])}</h2>
    <div class="sub">${esc(s.address)}</div>
    <div class="actions">
      <a class="btn primary" href="${navUrl(s)}" target="_blank" rel="noopener">➤ Navigate</a>
      ${phone ? `<a class="btn secondary" href="tel:${esc(phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : '<button class="btn secondary" disabled>📞 No phone</button>'}
      <button class="btn secondary" id="stMove">↕ Move</button>
    </div>
    <div class="actions">${statusBtns}</div>
    <label class="lbl" for="stNote">Visit note</label>
    <textarea id="stNote" rows="2" placeholder="e.g. closed, manager not in, left with bartender">${esc(s.status_note)}</textarea>
    ${hoursCard}
    ${svcCard}
    <div class="card">
      <div class="card-title">Stop details</div>
      ${loc ? '' : `<label class="lbl" for="stName">Name</label><input id="stName" type="text" value="${esc(s.name)}">
      <label class="lbl" for="stAddr">Address</label><input id="stAddr" type="text" value="${esc(s.address)}">
      <label class="lbl" for="stPhone">Phone</label><input id="stPhone" type="text" inputmode="tel" value="${esc(s.phone)}">`}
      <label class="lbl" for="stNotes">Notes for this stop</label><textarea id="stNotes" rows="2">${esc(s.notes)}</textarea>
      <button class="btn primary block mt" id="stSave">Save</button>
    </div>
    <button class="btn danger block" id="stDelete">Remove stop from route</button>
    <button class="btn secondary block mt" id="stClose">Close</button>
  `, (el) => {
    el.querySelector('#stClose').onclick = closeSheet;
    el.querySelectorAll('[data-st]').forEach((b) => b.onclick = async () => {
      const st = b.dataset.st;
      await updateStop(s, { status: st, status_note: el.querySelector('#stNote').value.trim(), completed_at: st === 'pending' ? null : new Date().toISOString() });
      closeSheet(); renderRoute();
      if (st === 'done') { celebrateDone(); toast('Marked done ✔'); }
    });
    el.querySelector('#stNote').onchange = (e) => updateStop(s, { status_note: e.target.value.trim() });
    el.querySelectorAll('[data-ans]').forEach((b) => b.onclick = async () => {
      await answerHours(s, b.dataset.ans === 'early');
      closeSheet(); toast(b.dataset.ans === 'early' ? 'Got it — hours ignored for this stop. Tap Optimize to update.' : 'Got it — it will wait until opening. Tap Optimize to update.');
    });

    el.querySelectorAll('[data-seg]').forEach((sg) => sg.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const f = sg.dataset.seg, v = b.dataset.v;
      if (f === 'ignore_hours') { await updateStop(s, { ignore_hours: v === 'true', hours_answer: v === 'true' ? 'early' : 'wait' }); renderRoute(); toast(v === 'true' ? 'Hours ignored for this stop — tap Optimize' : 'Hours apply again'); return; }
      if (f.startsWith('rt')) {
        const tasks = svcOf(s).tasks.slice(); tasks[+f.slice(2)] = v;
        await updateStop(s, { rt_tasks: tasks });
        const ev = el.querySelector('#estVal'); if (ev) ev.textContent = `${svcOf(s).minutes} min`;
        renderRoute();
      }
    });
    const minEl = el.querySelector('#stMinutes');
    if (minEl) minEl.onchange = (e) => updateStop(s, { service_override: Math.max(0, Math.min(1440, parseInt(e.target.value, 10) || 0)) }).then(() => renderRoute());
    const ol = el.querySelector('#stOpenLoc');
    if (ol) ol.onclick = () => { closeSheet(); openLocation(loc.id, 'route'); };

    el.querySelector('#stSave').onclick = async () => {
      const patch = { notes: el.querySelector('#stNotes').value.trim() };
      if (!loc) {
        const addr = el.querySelector('#stAddr').value.trim();
        Object.assign(patch, { name: el.querySelector('#stName').value.trim(), phone: el.querySelector('#stPhone').value.trim() });
        if (addr && addr !== s.address) { Object.assign(patch, { address: addr, lat: null, lng: null }); S.geoFailed.delete(s.id); }
      }
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
      if (dbErr(error, 'Remove')) return;
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
      const { id, created_at, updated_at, owner_id, legs, geometry, total_distance, total_drive, optimized_at, started_at, completed_at, ...rest } = r;
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
  $('btnNewRoute').onclick = () => newRoute();
  $('routesList').onclick = (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); confirmDeleteRoute(del.dataset.del); return; }
    const c = e.target.closest('.route-card'); if (c) openRoute(c.dataset.id);
  };

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
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('searchResults').querySelector('.sr');
      if (first && !$('searchResults').classList.contains('hidden')) first.click();
    }
    if (e.key === 'Escape') hideResults();
  };
  $('searchResults').onclick = (e) => {
    const r = e.target.closest('.sr'); if (!r) return;
    if (r.dataset.loc) { $('searchInput').value = ''; hideResults(); addLocationsToRoute([S.locById.get(r.dataset.loc)]); return; }
    pickResult(r.dataset.i);
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) hideResults(); });

  $('btnPaste').onclick = openPaste;
  $('btnFromLocs').onclick = () => openLocPicker();
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('btnOptimize').onclick = () => optimize(false);
  $('btnKeepOrder').onclick = () => optimize(true);
  $('btnNavMulti').onclick = openGoogleMulti;

  const openFromList = (e) => {
    const d = e.target.closest('[data-done]');
    if (d) {
      const s = S.stops.find((x) => x.id === d.dataset.done);
      if (s) { celebrateDone(); updateStop(s, { status: 'done', completed_at: new Date().toISOString() }).then(() => { renderRoute(); toast('Marked done ✔'); }); }
      return;
    }
    if (DRAG.justDropped || DRAG.active) return;
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
  bindLocations();
  initStopDrag();
  initSheetDrag();
  $('btnGenPass').onclick = () => { $('nuPass').value = genPassword(); };
  $('teamList').onclick = onTeamClick;
  $('btnTeamRefresh').onclick = loadTeam;
}

// ======================================================================
// Boot
// ======================================================================
// ---------- Animations (Lottie AI exports, animated SVG) ----------
const ANIM_OK = () => !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const animCache = {};
let animSeq = 0;
/** Load an animation and return a fresh <svg> element (ids made unique so several can be on screen at once). */
async function animSvg(name, cover = false) {
  if (!animCache[name]) {
    const res = await fetch(`anim/${name}.svg`);
    if (!res.ok) throw new Error('anim ' + name);
    animCache[name] = await res.text();
  }
  const p = `a${++animSeq}_`;
  const txt = animCache[name]
    .replace(/\bid="([^"]+)"/g, `id="${p}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${p}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${p}$1"`);
  const box = document.createElement('div');
  box.innerHTML = txt;
  const svg = box.querySelector('svg');
  svg.setAttribute('preserveAspectRatio', cover ? 'xMidYMid slice' : 'xMidYMid meet');
  return svg;
}
function startSvg(svg) { try { svg.setCurrentTime(0); svg.unpauseAnimations(); } catch (e) { /* */ } }

/** Full-screen or centered one-shot animation. Resolves when finished (or tapped, if allowed). */
async function playFx(name, { ms, cover = false, text = '', tapSkip = false, onMidway, midway = 0.7, dim = false } = {}) {
  if (!ANIM_OK()) { if (onMidway) onMidway(); return; }
  let svg;
  try { svg = await animSvg(name, cover); } catch (e) { if (onMidway) onMidway(); return; }
  const fx = document.createElement('div');
  fx.className = `fx ${cover ? 'fx-cover' : 'fx-center'} ${dim ? 'fx-dim' : ''} ${tapSkip ? '' : 'fx-passive'}`;
  const art = document.createElement('div'); art.className = 'fx-art'; art.appendChild(svg);
  fx.appendChild(art);
  if (text) { const t = document.createElement('div'); t.className = 'fx-text'; t.textContent = text; fx.appendChild(t); }
  document.body.appendChild(fx);
  startSvg(svg);
  return new Promise((resolve) => {
    let done = false;
    const mid = setTimeout(() => { if (onMidway) onMidway(); }, ms * midway);
    const end = () => {
      if (done) return; done = true; clearTimeout(mid); clearTimeout(t1);
      if (onMidway && !fx.dataset.mid) { /* skipped before midway */ }
      fx.classList.add('fx-out');
      setTimeout(() => { fx.remove(); resolve(); }, 320);
    };
    const t1 = setTimeout(end, ms);
    if (tapSkip) fx.onclick = () => { clearTimeout(mid); if (onMidway) onMidway(); end(); };
  });
}

// "Finding the best route…" loader for Optimize (shows at least ~1 s so it doesn't flash)
let loaderEl = null, loaderAt = 0;
async function showLoader(text) {
  if (!ANIM_OK()) { busy(true); return; }
  loaderAt = Date.now();
  loaderEl = document.createElement('div');
  loaderEl.className = 'fx fx-center fx-dim';
  loaderEl.innerHTML = `<div class="fx-card"><div class="fx-art small"></div><div class="fx-cardtext">${esc(text)}</div></div>`;
  document.body.appendChild(loaderEl);
  const el = loaderEl;
  try { const svg = await animSvg('optimizing'); if (el.isConnected) { el.querySelector('.fx-art').appendChild(svg); startSvg(svg); } } catch (e) { /* spinner-less is fine */ }
}
async function hideLoader() {
  if (!loaderEl) { busy(false); return; }
  const el = loaderEl; loaderEl = null;
  const wait = 1000 - (Date.now() - loaderAt);
  if (wait > 0) await sleep(wait);
  el.classList.add('fx-out'); setTimeout(() => el.remove(), 320);
}

function celebrateDone() { playFx('done', { ms: 950 }); }

// Moving map behind the sign-in card
async function startLoginBackground() {
  const host = $('loginBg');
  if (!host || host.firstChild || !ANIM_OK()) return;
  try { const svg = await animSvg('signin-bg', true); host.appendChild(svg); startSvg(svg); } catch (e) { /* plain navy is fine */ }
}

// ---------- Opening animation: once a day, tap to skip, skipped for "reduce motion" ----------
async function playIntro() {
  const el = $('intro');
  let seen = '';
  try { seen = localStorage.getItem('sn.introDay') || ''; } catch (e) { /* */ }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (seen === todayISO() || reduce) return;
  let svg;
  try {
    const res = await fetch('anim/intro.svg');
    if (!res.ok) return;
    svg = await res.text();
  } catch (e) { return; }
  $('introArt').innerHTML = svg;
  el.classList.remove('hidden');
  const timers = [];
  const finish = () => {
    timers.forEach(clearTimeout);
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('out'); $('introArt').innerHTML = ''; }, 500);
  };
  try { localStorage.setItem('sn.introDay', todayISO()); } catch (e) { /* */ }
  el.onclick = finish;
  timers.push(setTimeout(() => $('introTitle').classList.add('show'), 2500));
  timers.push(setTimeout(finish, 4200));
}

window.addEventListener('DOMContentLoaded', () => {
  loadPrefs();
  playIntro();
  bind();
  initAuth();
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
