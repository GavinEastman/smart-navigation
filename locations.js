/* Smart Navigation — shared locations: list, profile, editor, route picker, activity log, one-time import. */
'use strict';

const LOC_COLS = 'id,name,street,city,state,zip,phone,account_manager,account_manager_phone,hours,hours_comment,open_24_7,' +
  'access_anytime,access_method,games_confirmed,ach,payout_tickets,notes,lat,lng,extra,incomplete,version,updated_at,updated_by_email,' +
  'devices(id,position,category,type,extra),contacts(id,position,name,phone,email,role,extra)';

const L_STATE = { tab: 'routes', shown: 150, from: 'list', current: null, draft: null };

// ======================================================================
// Loading & helpers
// ======================================================================
function sortChildren(l) {
  (l.devices || []).sort((a, b) => a.position - b.position);
  (l.contacts || []).sort((a, b) => a.position - b.position);
  return l;
}
function setLocations(list) {
  S.locations = list.map(sortChildren).sort((a, b) => a.name.localeCompare(b.name));
  S.locById = new Map(S.locations.map((l) => [l.id, l]));
  S.locLoaded = true;
}
function putLocation(l) {
  sortChildren(l);
  const i = S.locations.findIndex((x) => x.id === l.id);
  if (i >= 0) S.locations[i] = l; else { S.locations.push(l); S.locations.sort((a, b) => a.name.localeCompare(b.name)); }
  S.locById.set(l.id, l);
}

let locLoading = null;
async function loadLocations() {
  if (locLoading) return locLoading;
  locLoading = (async () => {
    const all = [];
    for (let from = 0; ; from += 500) {
      const { data, error } = await sb.from('locations').select(LOC_COLS).order('name').range(from, from + 499);
      if (error) { if (!/does not exist|schema cache/i.test(error.message)) dbErr(error, 'Loading locations'); break; }
      all.push(...data);
      if (data.length < 500) break;
    }
    setLocations(all);
    if (L_STATE.tab === 'locations') renderLocList();
    if (currentView === 'route') renderRoute();
  })();
  try { await locLoading; } finally { locLoading = null; }
}

async function reloadLocation(id) {
  const { data, error } = await sb.from('locations').select(LOC_COLS).eq('id', id).single();
  if (dbErr(error, 'Loading location')) return null;
  putLocation(data);
  return data;
}

const locAddress = (l) => [l.street, l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const norm = (s) => String(s || '').toLowerCase();

function matchLocations(q) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return S.locations.filter((l) => {
    const hay = norm(`${l.name} ${l.street} ${l.city} ${l.zip} ${l.account_manager}`);
    return words.every((w) => hay.includes(w));
  });
}

function locMissing(l) {
  const rt = rtCountOf(l);
  return SN.locationService({ games: l.games_confirmed, ach: l.ach, payout: l.payout_tickets, rtCount: rt, rtTasks: [] }, 1).missing;
}

async function saveLocCoords(loc, g) {
  loc.lat = g.lat; loc.lng = g.lng;
  const { error } = await sb.from('locations').update({ lat: g.lat, lng: g.lng }).eq('id', loc.id);
  if (error) console.warn(error);
}

async function logActivity(action, target, detail) {
  await sb.from('activity').insert({ action, target, detail, actor: S.session.user.id });
}

// ======================================================================
// Tabs + location list
// ======================================================================
function switchTab(tab) {
  L_STATE.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  $('paneRoutes').classList.toggle('hidden', tab !== 'routes');
  $('paneLocations').classList.toggle('hidden', tab !== 'locations');
  if (tab === 'locations') { if (!S.locLoaded) loadLocations(); renderLocList(); }
}

function renderLocList() {
  // city dropdown
  const cities = [...new Set(S.locations.map((l) => l.city).filter(Boolean))].sort();
  const sel = $('locCity'), cur = sel.value;
  if (sel.options.length !== cities.length + 1) {
    sel.innerHTML = '<option value="">All cities</option>' + cities.map((c) => `<option>${esc(c)}</option>`).join('');
    sel.value = cur;
  }
  const q = $('locSearch').value.trim(), city = sel.value, filt = $('locFilter').value;
  let list = q ? matchLocations(q) : S.locations.slice();
  if (city) list = list.filter((l) => l.city === city);
  if (filt === 'needs') list = list.filter((l) => locMissing(l).length);
  if (filt === 'access') list = list.filter((l) => l.access_anytime);
  if (filt === 'incomplete') list = list.filter((l) => l.incomplete);

  $('locCount').textContent = S.locLoaded ? `(${list.length}${list.length !== S.locations.length ? ' of ' + S.locations.length : ''})` : '';
  $('locEmpty').classList.toggle('hidden', list.length > 0 || !S.locLoaded);
  $('locEmptyText').innerHTML = S.locations.length ? 'No matches.' : 'No locations yet.<br>Tap <b>+ New</b> to add one.';
  const shown = list.slice(0, L_STATE.shown);
  $('locList').innerHTML = shown.map((l) => {
    const miss = locMissing(l);
    const tags = [];
    if (miss.length) tags.push('<span class="tag warn">⚠️ Settings needed</span>');
    if (l.access_anytime) tags.push(`<span class="tag key">${esc(ACCESS_LABEL[l.access_method || ''])}</span>`);
    if (l.incomplete) tags.push('<span class="tag">Incomplete</span>');
    const g = gameCountOf(l), rt = rtCountOf(l);
    if (g || rt) tags.push(`<span class="tag">🎰 ${g}${rt ? ` · RT ${rt}` : ''}</span>`);
    return `<div class="loc-card" data-loc="${esc(l.id)}">
      <div class="name">${esc(l.name)}</div>
      <div class="addr">${esc(locAddress(l) || 'No address')}${l.account_manager ? ' · ' + esc(l.account_manager) : ''}</div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
    </div>`;
  }).join('');
  $('locMore').classList.toggle('hidden', list.length <= L_STATE.shown);
}

// ======================================================================
// Location profile
// ======================================================================
async function openLocation(id, from = 'list') {
  L_STATE.from = from;
  let l = S.locById.get(id);
  if (!l) l = await reloadLocation(id);
  if (!l) return;
  L_STATE.current = id;
  show('location');
  renderLocation();
  reloadLocation(id).then((fresh) => { if (fresh && L_STATE.current === id && currentView === 'location') renderLocation(); });
}

function telLink(phone, label = '📞 Call') {
  const p = String(phone || '').replace(/[^+\d]/g, '');
  return p ? `<a class="btn secondary sm" href="tel:${esc(p)}">${label}</a>` : '';
}
function smsLink(phone) {
  const p = String(phone || '').replace(/[^+\d]/g, '');
  return p ? `<a class="btn secondary sm" href="sms:${esc(p)}">💬 Text</a>` : '';
}
const EXTRA_LABELS = {
  accountNumber: 'Account #', licenseNumber: 'License #', ballyId: 'Bally ID', legalName: 'Legal name',
  customerServiceRep: 'Customer service rep', primaryCollector: 'Primary collector', territory: 'Territory', region: 'Region',
  reportedSkillGameCount: 'Spreadsheet game count', reportedRedemptionTerminals: 'Spreadsheet RTs',
};

function renderLocation() {
  const l = S.locById.get(L_STATE.current);
  if (!l) return;
  $('locTitle').textContent = l.name;
  const today = new Date().getDay();
  const h = hoursToday(l);
  const rt = rtCountOf(l), games = gameCountOf(l);
  const miss = locMissing(l);
  const tri = (v, y, n) => (v === true ? y : v === false ? n : '<span class="err">Unknown</span>');
  const skill = (l.devices || []).filter((d) => /skill/i.test(d.category));
  const rts = (l.devices || []).filter((d) => /redemption/i.test(d.category));
  const other = (l.devices || []).filter((d) => !/skill|redemption/i.test(d.category));
  const devLine = (d) => `• ${esc(d.type || '(no model)')}${d.extra && d.extra.serialNumber ? ` <span class="hint">SN ${esc(d.extra.serialNumber)}</span>` : ''}${d.extra && d.extra.assetNumber ? ` <span class="hint">Asset ${esc(d.extra.assetNumber)}</span>` : ''}`;
  const extras = Object.entries(EXTRA_LABELS).filter(([k]) => l.extra && l.extra[k] != null && l.extra[k] !== '')
    .map(([k, lab]) => `<span class="k">${esc(lab)}</span><span>${esc(l.extra[k])}</span>`).join('');

  $('locBody').innerHTML = `
    ${l.incomplete ? '<div class="warn-box">Incomplete record — the spreadsheet had no address, phone or hours for this location. Fill in what you know with ✎ Edit.</div>' : ''}
    <div class="card">
      <div class="strong" style="font-size:18px">${esc(l.name)}</div>
      <div>${esc(locAddress(l) || 'No address on file')}</div>
      ${l.phone ? `<div class="hint">Phone: ${esc(l.phone)}</div>` : ''}
      <div class="actions">
        ${locAddress(l) ? `<a class="btn primary" href="${navUrl({ lat: l.lat, lng: l.lng, address: locAddress(l) })}" target="_blank" rel="noopener">➤ Navigate</a>` : '<button class="btn primary" disabled>➤ Navigate</button>'}
        ${l.phone ? `<a class="btn secondary" href="tel:${esc(l.phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : '<button class="btn secondary" disabled>📞 Call</button>'}
        <button class="btn lime" id="lpAdd">+ Route</button>
      </div>
      ${l.account_manager ? `<div class="row between"><span class="hint">Account manager: <b>${esc(l.account_manager)}</b></span>${telLink(l.account_manager_phone)}</div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">Service settings</div>
      ${miss.length ? `<div class="warn-box">Needed before this stop can be optimized: ${miss.map(esc).join(', ')}.</div>` : ''}
      <div class="kv">
        <span class="k">Skill games</span><span>${l.games_confirmed != null ? l.games_confirmed + ' (confirmed)' : `<span class="err">Not confirmed</span>`}</span>
        <span class="k">Redemption terminals</span><span>${rt}</span>
        <span class="k">ACH</span><span>${tri(l.ach, 'ACH', 'Non-ACH')}</span>
        <span class="k">Payout tickets</span><span>${rt ? 'No (has RT)' : tri(l.payout_tickets, 'Yes', 'No')}</span>
      </div>
      ${l.games_confirmed == null || l.games_confirmed !== games ? `<button class="btn secondary block mt" id="lpConfirm">✔ Confirm ${games} skill game${games === 1 ? '' : 's'} (from device list)</button>` : ''}
      <div class="lbl">ACH</div>${seg('ach', [['true', 'ACH'], ['false', 'Non-ACH'], ['', 'Unknown']], l.ach == null ? '' : String(l.ach))}
      ${rt ? '' : `<div class="lbl">Payout tickets</div>${seg('payout_tickets', [['true', 'Yes'], ['false', 'No'], ['', 'Unknown']], l.payout_tickets == null ? '' : String(l.payout_tickets))}`}
    </div>

    <div class="card">
      <div class="card-title">Hours</div>
      ${l.open_24_7 || SN.is247(l.hours_comment) ? '<div class="ok-box">Open 24/7</div>' : ''}
      ${l.access_anytime ? `<div class="ok-box">${esc(ACCESS_LABEL[l.access_method || ''])} — can be scheduled any time, outside business hours.</div>` : ''}
      ${SN.DAYS.map((d, i) => `<div class="hours-row ${i === today ? 'today' : ''}"><span>${d[0].toUpperCase() + d.slice(1)}</span><span>${esc((l.hours || {})[d] || '—')}</span></div>`).join('')}
      ${l.hours_comment ? `<div class="hint">${esc(l.hours_comment)}</div>` : ''}
      <div class="hint">Today: ${esc(h.status)}</div>
    </div>

    <div class="card">
      <div class="card-title">Contacts (${(l.contacts || []).length})</div>
      ${(l.contacts || []).map((c) => `<div class="contact">
        <div class="strong">${esc(c.name || '(no name)')}${c.role ? ` <span class="hint">· ${esc(c.role)}</span>` : ''}</div>
        <div class="hint">${esc(c.phone || '')}${c.email ? ' · ' + esc(c.email) : ''}</div>
        <div class="row gap6">${telLink(c.phone)}${smsLink(c.phone)}${c.email ? `<a class="btn secondary sm" href="mailto:${esc(c.email)}">✉️ Email</a>` : ''}</div>
      </div>`).join('') || '<div class="hint">No contacts on file.</div>'}
    </div>

    <div class="card">
      <div class="card-title">Equipment (${(l.devices || []).length})</div>
      <div class="dev-list">
        <b>Skill games (${skill.length})</b><br>${skill.map(devLine).join('<br>') || '<span class="hint">None</span>'}<br>
        <b>Redemption terminals (${rts.length})</b><br>${rts.map(devLine).join('<br>') || '<span class="hint">None</span>'}
        ${other.length ? `<br><b>Other (${other.length})</b><br>${other.map((d) => `• ${esc(d.category)}: ${esc(d.type)}`).join('<br>')}` : ''}
      </div>
    </div>

    ${l.notes ? `<div class="card"><div class="card-title">Notes</div><div style="white-space:pre-wrap">${esc(l.notes)}</div></div>` : ''}
    ${extras ? `<div class="card"><div class="card-title">Account details</div><div class="kv">${extras}</div></div>` : ''}

    <p class="credits">${l.updated_by_email ? `Last changed by ${esc(l.updated_by_email)} · ` : ''}${l.updated_at ? new Date(l.updated_at).toLocaleString() : ''}<br>
      Map point: ${l.lat != null ? 'set' : 'not yet found'}</p>
  `;

  $('lpAdd').onclick = () => addLocationsToRoute([l], true);
  const conf = $('lpConfirm');
  if (conf) conf.onclick = () => quickSave(l, { games_confirmed: games }, `Confirmed ${games} skill games`);
  $('locBody').querySelectorAll('[data-seg]').forEach((sg) => sg.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.v === '' ? null : b.dataset.v === 'true';
    quickSave(l, { [sg.dataset.seg]: v }, 'Saved');
  });
}

// ======================================================================
// Saving (version-checked, so two people can't overwrite each other)
// ======================================================================
function locPayload(l) {
  const keys = ['id', 'name', 'street', 'city', 'state', 'zip', 'phone', 'account_manager', 'account_manager_phone', 'hours', 'hours_comment',
    'open_24_7', 'access_anytime', 'access_method', 'games_confirmed', 'ach', 'payout_tickets', 'notes', 'lat', 'lng', 'extra'];
  return Object.fromEntries(keys.map((k) => [k, l[k] ?? null]));
}
const childPayload = (arr, keys) => (arr || []).map((x) => Object.fromEntries(keys.map((k) => [k, x[k] ?? (k === 'extra' ? {} : '')])));

async function saveLocation(l, expectedVersion) {
  const { data, error } = await sb.rpc('save_location', {
    p_loc: locPayload(l),
    p_contacts: childPayload(l.contacts, ['name', 'phone', 'email', 'role', 'extra']),
    p_devices: childPayload(l.devices, ['category', 'type', 'extra']),
    p_expected: expectedVersion || 0,
  });
  if (error) {
    if (/CONFLICT/i.test(error.message)) {
      toast('Someone else just changed this location. It has been reloaded — please make your change again.', 6000);
      if (l.id) await reloadLocation(l.id);
      return null;
    }
    dbErr(error);
    return null;
  }
  const fresh = await reloadLocation(data.id);
  return fresh;
}

async function quickSave(l, patch, msg) {
  busy(true);
  const draft = { ...l, ...patch };
  const saved = await saveLocation(draft, l.version);
  busy(false);
  if (saved) toast(msg);
  if (currentView === 'location') renderLocation();
  if (currentView === 'route' || S.route) renderRoute();
}

// ======================================================================
// Location editor
// ======================================================================
function openLocEditor(id) {
  const base = id ? S.locById.get(id) : {
    id: '', name: '', street: '', city: '', state: 'NE', zip: '', phone: '', account_manager: '', account_manager_phone: '',
    hours: {}, hours_comment: '', open_24_7: false, access_anytime: false, access_method: '', games_confirmed: null,
    ach: null, payout_tickets: null, notes: '', lat: null, lng: null, extra: {}, contacts: [], devices: [], version: 0,
  };
  L_STATE.draft = JSON.parse(JSON.stringify(base));
  L_STATE.draft._origAddress = locAddress(base);
  $('editTitle').textContent = id ? 'Edit location' : 'New location';
  show('locedit');
  renderEditor();
}

function renderEditor() {
  const d = L_STATE.draft;
  const inp = (key, label, type = 'text', extra = '') =>
    `<label class="lbl" for="e_${key}">${label}</label><input id="e_${key}" data-k="${key}" type="${type}" value="${esc(d[key] ?? '')}" ${extra}>`;
  const rt = (d.devices || []).some((x) => /redemption/i.test(x.category));
  $('editBody').innerHTML = `
    <div class="card">
      <div class="card-title">Location</div>
      ${inp('name', 'Location name *')}
      ${inp('street', 'Street address')}
      <div class="row gap6"><div style="flex:2">${inp('city', 'City')}</div><div style="flex:1">${inp('state', 'State')}</div><div style="flex:1.3">${inp('zip', 'ZIP', 'text', 'inputmode="numeric"')}</div></div>
      ${inp('phone', 'Location phone', 'text', 'inputmode="tel"')}
      <div class="row gap6"><div style="flex:1">${inp('account_manager', 'Account manager')}</div><div style="flex:1">${inp('account_manager_phone', 'Manager phone', 'text', 'inputmode="tel"')}</div></div>
      <button class="btn secondary block mt" id="eGps" type="button">📍 Set map point to where I'm standing</button>
      <div class="hint" id="eGpsMsg">${d.lat != null ? 'Map point is set.' : 'Map point will be found from the address.'}</div>
    </div>

    <div class="card">
      <div class="card-title">Service settings</div>
      <div class="svc"><span class="lb">Skill games (confirmed)</span>
        <div class="stepper"><button type="button" id="gMinus">−</button><span id="gVal">${d.games_confirmed ?? '?'}</span><button type="button" id="gPlus">+</button></div></div>
      <button type="button" class="btn secondary sm" id="gUnset">Mark as not confirmed</button>
      <div class="lbl">ACH</div>${seg('ach', [['true', 'ACH'], ['false', 'Non-ACH'], ['', 'Unknown']], d.ach == null ? '' : String(d.ach))}
      <div class="lbl">Payout tickets${rt ? ' (not allowed with an RT)' : ''}</div>${seg('payout_tickets', [['true', 'Yes'], ['false', 'No'], ['', 'Unknown']], rt ? 'false' : d.payout_tickets == null ? '' : String(d.payout_tickets), rt)}
    </div>

    <div class="card">
      <div class="card-title">Hours</div>
      <div class="hint">Format: 7:00 AM - 10:00 PM · split: 6:00 AM - 1:00 PM; 4:00 PM - 9:00 PM · or Closed. After-midnight closing (e.g. 2:00 AM) belongs to the day it opened.</div>
      ${SN.DAYS.map((day) => `<label class="lbl" for="h_${day}">${day[0].toUpperCase() + day.slice(1)}</label>
        <input id="h_${day}" data-h="${day}" type="text" value="${esc((d.hours || {})[day] || '')}" placeholder="e.g. 11:00 AM - 2:00 AM">`).join('')}
      ${inp('hours_comment', 'Hours comment')}
      <label class="switch-row mt"><span>Open 24/7</span><input type="checkbox" id="e_247" ${d.open_24_7 ? 'checked' : ''}></label>
    </div>

    <div class="card">
      <div class="card-title">After-hours access</div>
      <label class="switch-row"><span>We can get in any time</span><input type="checkbox" id="e_access" ${d.access_anytime ? 'checked' : ''}></label>
      <div class="hint">Turn on if you have a key or door code, or can call the owner to be let in. Routes will then ignore this location's hours.</div>
      <div id="accessHow" class="${d.access_anytime ? '' : 'hidden'}">
        <div class="lbl">How do we get in?</div>
        ${seg('access_method', [['key', '🔑 Key'], ['code', '🔢 Door code'], ['call', '📞 Call owner']], d.access_method)}
        <div class="hint">Don't write the actual door code here — keep codes in your protected system.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Contacts</div>
      <div id="eContacts">${(d.contacts || []).map((c, i) => `<div class="card" style="margin-bottom:8px">
        <div class="edit-row"><input data-c="${i}" data-ck="name" placeholder="Name" value="${esc(c.name)}"><button class="x-btn" data-delc="${i}" type="button">✕</button></div>
        <div class="edit-row"><input data-c="${i}" data-ck="phone" placeholder="Phone" inputmode="tel" value="${esc(c.phone)}"><input data-c="${i}" data-ck="role" placeholder="Role" value="${esc(c.role)}"></div>
        <div class="edit-row"><input data-c="${i}" data-ck="email" placeholder="Email" type="email" value="${esc(c.email)}"></div>
      </div>`).join('')}</div>
      <button class="btn secondary block" id="eAddContact" type="button">+ Add contact</button>
    </div>

    <div class="card">
      <div class="card-title">Equipment (${(d.devices || []).length})</div>
      <div class="hint">Every machine is its own row — two of the same model stay as two rows.</div>
      <div id="eDevices" class="mt">${(d.devices || []).map((x, i) => `<div class="edit-row">
        <select data-d="${i}" data-dk="category" style="flex:0 0 42%">
          ${['Skill Game', 'Redemption Terminal', 'Other'].map((c) => `<option ${x.category === c || (c === 'Other' && !/skill game|redemption terminal/i.test(x.category)) ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <input data-d="${i}" data-dk="type" placeholder="Model" value="${esc(x.type)}">
        <button class="x-btn" data-deld="${i}" type="button">✕</button></div>`).join('')}</div>
      <div class="row gap6"><button class="btn secondary" style="flex:1" id="eAddGame" type="button">+ Skill game</button><button class="btn secondary" style="flex:1" id="eAddRt" type="button">+ Redemption terminal</button></div>
    </div>

    <div class="card">
      <div class="card-title">Notes</div>
      <textarea id="e_notes" rows="3" maxlength="250">${esc(d.notes)}</textarea>
      <div class="hint"><span id="notesCount">${(d.notes || '').length}</span>/250 · Don't store door codes or passwords here.</div>
    </div>

    <button class="btn primary block big" id="eSave">Save location</button>
    ${d.id ? '<button class="btn danger block mt" id="eDelete">Delete location</button>' : ''}
    <button class="btn secondary block mt" id="eCancel2">Cancel</button>
    <p class="credits"></p>`;

  const body = $('editBody');
  body.querySelectorAll('[data-k]').forEach((el) => el.oninput = () => { d[el.dataset.k] = el.value; });
  body.querySelectorAll('[data-h]').forEach((el) => el.oninput = () => { d.hours = { ...(d.hours || {}), [el.dataset.h]: el.value }; });
  body.querySelectorAll('[data-c]').forEach((el) => el.oninput = () => { d.contacts[+el.dataset.c][el.dataset.ck] = el.value; });
  body.querySelectorAll('[data-d]').forEach((el) => el.oninput = el.onchange = () => {
    d.devices[+el.dataset.d][el.dataset.dk] = el.value;
    if (el.dataset.dk === 'category') renderEditorKeep();
  });
  body.querySelectorAll('[data-delc]').forEach((b) => b.onclick = () => { d.contacts.splice(+b.dataset.delc, 1); renderEditorKeep(); });
  body.querySelectorAll('[data-deld]').forEach((b) => b.onclick = () => { d.devices.splice(+b.dataset.deld, 1); renderEditorKeep(); });
  $('eAddContact').onclick = () => { d.contacts.push({ name: '', phone: '', email: '', role: '', extra: {} }); renderEditorKeep(); };
  $('eAddGame').onclick = () => { d.devices.push({ category: 'Skill Game', type: '', extra: {} }); renderEditorKeep(); };
  $('eAddRt').onclick = () => { d.devices.push({ category: 'Redemption Terminal', type: '', extra: {} }); d.payout_tickets = false; renderEditorKeep(); };
  const setG = (v) => { d.games_confirmed = v; $('gVal').textContent = v ?? '?'; };
  $('gMinus').onclick = () => setG(Math.max(0, (d.games_confirmed ?? gameCountOf(d)) - 1));
  $('gPlus').onclick = () => setG(Math.min(200, (d.games_confirmed ?? gameCountOf(d) - 1) + 1));
  $('gUnset').onclick = () => setG(null);
  $('e_247').onchange = (e) => { d.open_24_7 = e.target.checked; };
  $('e_access').onchange = (e) => { d.access_anytime = e.target.checked; $('accessHow').classList.toggle('hidden', !e.target.checked); };
  $('e_notes').oninput = (e) => { d.notes = e.target.value.slice(0, 250); $('notesCount').textContent = d.notes.length; };
  body.querySelectorAll('[data-seg]').forEach((sg) => sg.onclick = (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    const k = sg.dataset.seg;
    d[k] = k === 'access_method' ? b.dataset.v : b.dataset.v === '' ? null : b.dataset.v === 'true';
  });
  $('eGps').onclick = async () => {
    $('eGpsMsg').textContent = 'Getting your location…';
    const g = await getGPS();
    if (!g) { $('eGpsMsg').textContent = 'Location not available.'; return; }
    d.lat = g.lat; d.lng = g.lng; d._pinned = true;
    $('eGpsMsg').textContent = `Map point set to your current position (${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}).`;
  };
  $('eSave').onclick = saveEditor;
  $('eCancel2').onclick = closeEditor;
  const del = $('eDelete');
  if (del) del.onclick = (e) => twoTap(e.currentTarget, deleteLocation, 'Tap again to delete for everyone');
}
function renderEditorKeep() { const y = window.scrollY; renderEditor(); window.scrollTo(0, y); }

function closeEditor() {
  const d = L_STATE.draft;
  if (d && d.id) { show('location'); renderLocation(); } else { show('routes'); switchTab('locations'); }
}

async function saveEditor() {
  const d = L_STATE.draft;
  if (!String(d.name || '').trim()) { toast('Location name is required.'); return; }
  for (const day of SN.DAYS) {
    const v = (d.hours || {})[day];
    if (v && v.trim() && SN.parseDayHours(v) === null && !/^(-|22)$/.test(v.trim())) {
      toast(`${day[0].toUpperCase() + day.slice(1)} hours not understood: "${v}". Use e.g. 7:00 AM - 10:00 PM, or Closed.`, 6000); return;
    }
  }
  if (!d._pinned && locAddress(d) !== d._origAddress) { d.lat = null; d.lng = null; } // address changed → find again
  if (d.access_anytime && !d.access_method) d.access_method = 'key';
  if (!d.access_anytime) d.access_method = '';
  busy(true);
  const saved = await saveLocation(d, d.version);
  busy(false);
  if (!saved) { if (d.id) { show('location'); renderLocation(); } return; }
  toast('Location saved ✔');
  if (saved.lat == null && locAddress(saved)) {
    geocode(locAddress(saved)).then((g) => { if (g) saveLocCoords(saved, g); });
  }
  L_STATE.current = saved.id;
  show('location'); renderLocation();
}

async function deleteLocation() {
  const d = L_STATE.draft;
  busy(true);
  const { error } = await sb.from('locations').delete().eq('id', d.id);
  busy(false);
  if (dbErr(error, 'Delete')) return;
  await logActivity('deleted location', d.id, d.name);
  S.locations = S.locations.filter((l) => l.id !== d.id); S.locById.delete(d.id);
  toast('Location deleted');
  show('routes'); switchTab('locations');
}

// ======================================================================
// Add locations to a route
// ======================================================================
async function addLocationsToRoute(locs, fromProfile = false) {
  locs = locs.filter(Boolean);
  if (!locs.length) return;
  if (fromProfile || !S.route) {
    // From a profile: pick which route
    const { data: routes } = await sb.from('routes').select('id,name,route_date').order('route_date', { ascending: false }).limit(10);
    openSheet(`<h2>Add to which route?</h2><div class="sub">${esc(locs.map((l) => l.name).join(', '))}</div>
      ${(routes || []).map((r) => `<button class="btn secondary block mt" data-rid="${r.id}">${esc(r.name)} <span class="hint">· ${esc(fmtDate(r.route_date))}</span></button>`).join('')}
      <button class="btn primary block mt" id="arNew">+ New route</button>
      <button class="btn secondary block mt" id="arClose">Cancel</button>`, (el) => {
      el.querySelector('#arClose').onclick = closeSheet;
      el.querySelectorAll('[data-rid]').forEach((b) => b.onclick = async () => { closeSheet(); await openRoute(b.dataset.rid); addLocationsToRoute(locs); });
      el.querySelector('#arNew').onclick = () => { closeSheet(); newRoute(() => addLocationsToRoute(locs)); };
    });
    return;
  }
  const already = new Set(S.stops.map((s) => s.location_id).filter(Boolean));
  const fresh = locs.filter((l) => !already.has(l.id));
  if (!fresh.length) { toast('Already on this route.'); return; }
  const n = await addStops(fresh.map((l) => ({
    location_id: l.id, name: l.name, address: locAddress(l) || l.name, phone: l.phone || '',
    lat: l.lat, lng: l.lng, rt_tasks: Array(rtCountOf(l)).fill('Fill'),
  })));
  if (n) {
    const attn = S.stops.filter(needsHoursAnswer).length;
    toast(attn ? `Added ${n}. ⚠️ ${attn} not open at your start time — tap ${attn > 1 ? 'them' : 'it'} to answer.`
               : `Added ${n} location${n > 1 ? 's' : ''}${fresh.length < locs.length ? ` (${locs.length - fresh.length} already on route)` : ''}`, 4500);
  }
}

function openLocPicker() {
  const picked = new Set();
  const onRoute = new Set(S.stops.map((s) => s.location_id).filter(Boolean));
  openSheet(`<h2>Add from locations</h2>
    <input id="pkSearch" type="search" placeholder="🔍 Search name, address, city or manager" autocomplete="off">
    <div class="pick-list" id="pkList"></div>
    <button class="btn primary block mt" id="pkAdd" disabled>Add selected</button>
    <button class="btn secondary block mt" id="pkClose">Cancel</button>`, (el) => {
    const draw = () => {
      const q = el.querySelector('#pkSearch').value.trim();
      const list = (q ? matchLocations(q) : S.locations).slice(0, 80);
      el.querySelector('#pkList').innerHTML = list.map((l) => {
        const on = onRoute.has(l.id);
        return `<label class="pick ${on ? 'dis' : ''}"><input type="checkbox" data-pk="${esc(l.id)}" ${picked.has(l.id) ? 'checked' : ''} ${on ? 'disabled' : ''}>
          <div><div class="t">${esc(l.name)}${on ? ' <span class="tag">on route</span>' : ''}${locMissing(l).length ? ' <span class="tag warn">settings needed</span>' : ''}</div><div class="d">${esc(locAddress(l))}</div></div></label>`;
      }).join('') || '<div class="hint" style="padding:10px">No matches.</div>';
      el.querySelectorAll('[data-pk]').forEach((cb) => cb.onchange = () => {
        if (cb.checked) picked.add(cb.dataset.pk); else picked.delete(cb.dataset.pk);
        const b = el.querySelector('#pkAdd'); b.disabled = !picked.size; b.textContent = picked.size ? `Add ${picked.size} stop${picked.size > 1 ? 's' : ''}` : 'Add selected';
      });
    };
    el.querySelector('#pkSearch').oninput = draw;
    el.querySelector('#pkClose').onclick = closeSheet;
    el.querySelector('#pkAdd').onclick = () => { const locs = [...picked].map((id) => S.locById.get(id)); closeSheet(); addLocationsToRoute(locs); };
    if (!S.locLoaded) loadLocations().then(draw); else draw();
  });
}

// ======================================================================
// Activity log
// ======================================================================
function ago(t) {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
async function openActivity() {
  const { data, error } = await sb.from('activity').select('*').order('at', { ascending: false }).limit(100);
  if (dbErr(error, 'Loading activity')) return;
  openSheet(`<h2>Recent location changes</h2><div class="sub">Who changed what, newest first.</div>
    <div class="card">${(data || []).map((a) => `<div class="act-row"><b>${esc((a.actor_email || 'someone').split('@')[0])}</b> ${esc(a.action)} <b>${esc(a.detail)}</b><div class="w">${esc(ago(a.at))}</div></div>`).join('') || '<div class="hint">Nothing yet.</div>'}</div>
    <button class="btn secondary block" id="acClose">Close</button>`, (el) => { el.querySelector('#acClose').onclick = closeSheet; });
}

// ======================================================================
// One-time import of source.json (owner only, from the hidden Manage Team screen)
// ======================================================================
function clean(v) { return v == null || String(v).trim() === '22' ? '' : String(v).trim(); }
function compact(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))); }

function convertSource(src) {
  const locs = [], contacts = [], devices = [];
  for (const p of src.locations || []) {
    const r = (p.locationRecords || [])[0] || null;
    const a = (r && r.address) || {};
    const hours = {};
    for (const d of SN.DAYS) { const v = r && r.hours ? clean(r.hours[d]) : ''; if (v) hours[d] = v; }
    const hasRt = (p.devices || []).some((d) => /redemption/i.test(d.category || ''));
    const comment = clean(r && r.hoursComment);
    locs.push({
      id: p.id, name: clean(p.name) || '(no name)',
      street: clean(a.street), city: clean(a.city), state: clean(a.state), zip: clean(a.postalCode),
      phone: clean(r && r.phone),
      account_manager: clean(r && r.accountManager && r.accountManager.name),
      account_manager_phone: clean(r && r.accountManager && r.accountManager.phone),
      hours, hours_comment: comment, open_24_7: SN.is247(comment),
      access_anytime: false, access_method: '', notes: '',
      games_confirmed: null, ach: null, payout_tickets: hasRt ? false : null,
      extra: r ? compact({
        accountNumber: r.accountNumber, licenseNumber: r.licenseNumber, ballyId: r.ballyId, legalName: r.legalName,
        customerServiceRep: r.customerServiceRep, primaryCollector: r.primaryCollector, territory: r.territory, region: r.region,
        reportedSkillGameCount: r.reportedSkillGameCount, reportedRedemptionTerminals: r.reportedRedemptionTerminals,
        sourceNotes: r.notes, source: r.source,
      }) : {},
      incomplete: !r,
    });
    (p.contacts || []).forEach((c, i) => contacts.push({
      location_id: p.id, position: i + 1, name: clean(c.name), phone: clean(c.phone), email: clean(c.email), role: clean(c.role),
      extra: compact({ source: c.source, sourceSlot: c.sourceSlot, notes: c.notes, sourceId: c.id }),
    }));
    (p.devices || []).forEach((d, i) => devices.push({
      location_id: p.id, position: i + 1, category: clean(d.category) || 'Skill Game', type: clean(d.type),
      extra: compact({ assetNumber: d.assetNumber, serialNumber: d.serialNumber, licenseNumber: d.licenseNumber, make: d.make,
        machineClass: d.machineClass, routeType: d.routeType, sourceLocationId: d.locationId, source: d.source, notes: d.notes, sourceId: d.id }),
    }));
  }
  return { locs, contacts: contacts.filter((c) => c.name || c.phone), devices };
}

async function importSource(file) {
  const msg = $('importMsg');
  const say = (t) => { msg.innerHTML = t; };
  try {
    say('Reading file…');
    const src = JSON.parse(await file.text());
    if (!Array.isArray(src.locations)) { say('<span class="err">That file doesn\'t look like source.json (no "locations" list).</span>'); return; }
    const { count, error: cErr } = await sb.from('locations').select('id', { count: 'exact', head: true });
    if (cErr) { say(`<span class="err">${esc(cErr.message)} — did you run supabase/002_locations.sql?</span>`); return; }
    if (count > 0) { say(`<span class="err">Import refused: ${count} locations already exist. Import only runs on an empty list so it can never overwrite edits.</span>`); return; }
    const { locs, contacts, devices } = convertSource(src);
    const steps = [['locations', locs, 100], ['contacts', contacts, 400], ['devices', devices, 400]];
    for (const [table, rows, size] of steps) {
      for (let i = 0; i < rows.length; i += size) {
        say(`Importing ${table}… ${Math.min(i + size, rows.length)} / ${rows.length}`);
        const { error } = await sb.from(table).insert(rows.slice(i, i + size));
        if (error) { say(`<span class="err">Stopped at ${table} ${i + 1}: ${esc(error.message)}</span>`); return; }
      }
    }
    await logActivity('imported', 'source.json', `${locs.length} locations, ${contacts.length} contacts, ${devices.length} devices`);
    say(`<span class="strong">✔ Imported ${locs.length} locations, ${contacts.length} contacts and ${devices.length} devices.</span>`);
    S.locLoaded = false; loadLocations();
  } catch (e) {
    console.error(e);
    say(`<span class="err">Couldn't import: ${esc(e.message)}</span>`);
  }
}

// ======================================================================
// Wire up
// ======================================================================
function bindLocations() {
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
  let t;
  $('locSearch').oninput = () => { clearTimeout(t); t = setTimeout(() => { L_STATE.shown = 150; renderLocList(); }, 150); };
  $('locCity').onchange = () => { L_STATE.shown = 150; renderLocList(); };
  $('locFilter').onchange = () => { L_STATE.shown = 150; renderLocList(); };
  $('locMore').onclick = () => { L_STATE.shown += 150; renderLocList(); };
  $('locList').onclick = (e) => { const c = e.target.closest('[data-loc]'); if (c) openLocation(c.dataset.loc, 'list'); };
  $('btnNewLoc').onclick = () => openLocEditor(null);
  $('btnLocBack').onclick = () => {
    if (L_STATE.from === 'route' && S.route) { show('route'); renderRoute(); }
    else { show('routes'); switchTab('locations'); }
  };
  $('btnLocEdit').onclick = () => openLocEditor(L_STATE.current);
  $('btnEditCancel').onclick = closeEditor;
  $('btnActivity').onclick = openActivity;
  $('importFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSource(f); };
}
