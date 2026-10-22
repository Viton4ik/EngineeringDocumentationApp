// Админ-панель: карточки, диаграммы, подключения, сотрудники, заявки, сообщения, блокировки, журнал, настройки.
const {esc, T, fmtSize, api, post, modal, toast, statusBadge} = Portal;
const $ = id => document.getElementById(id);
const CAN_APPROVE = !!(window.ADMIN && window.ADMIN.canApprove);
const ACTIONS = ['connect', 'preview', 'open', 'open_app', 'copy_path', 'download', 'properties', 'rescan', 'rename', 'helper_install', 'submit', 'resubmit', 'message',
  'admin_login', 'admin_login_fail', 'admin_logout', 'admin_password', 'admin_message', 'approve', 'sub_changes', 'sub_reject', 'sub_delete', 'block', 'unblock', 'blocked_attempt'];
const getJSON = async url => {const r = await api(url); if (r.status === 401) location.href = '/admin/login'; return r.json()};
const postJSON = async (url, body) => {const r = await post(url, body); const d = await r.json().catch(() => ({})); if (r.status === 401) location.href = '/admin/login'; return {ok: r.ok, ...d}};
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const daysAgo = n => {const d = new Date(); d.setDate(d.getDate() - n); return iso(d)};

// ---------- Вкладки ----------
const loaders = {};
let currentTab = 'overview';
function showTab(tab, filter) {
  currentTab = tab;
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('main [data-pane]').forEach(p => p.hidden = p.dataset.pane !== tab);
  history.replaceState(null, '', '#' + tab);
  loaders[tab] && loaders[tab](filter);
}
document.querySelectorAll('#tabs [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
document.querySelectorAll('[data-go]').forEach(c => c.onclick = () => showTab(c.dataset.go, c.dataset.filter));

// ---------- Карточки ----------
async function refreshCards() {
  const d = await getJSON('/api/admin/overview?from=' + daysAgo(0) + '&to=' + daysAgo(0));
  const c = d.cards;
  const set = (id, n) => {const el = $(id); el.textContent = n; el.closest('.card').classList.toggle('hot', n > 0)};
  set('cPending', c.pending); set('cResub', c.resubmitted); set('cMsgs', c.messages); set('cSec', c.security); set('cApproved', c.approved_today);
  $('cActive').textContent = c.active;
  const subsOpen = c.pending + c.resubmitted;
  $('bSubs').hidden = !subsOpen; $('bSubs').textContent = subsOpen; $('bMsgs').hidden = !c.messages; $('bMsgs').textContent = c.messages;
}

// ---------- Обзор: диаграммы ----------
const INK = '#52514e', MUTED = '#898781', GRID = '#e1e0d9', SERIES = '#2a78d6';
const STATUS_COLORS = {pending: '#fab219', resubmitted: '#2a78d6', changes: '#ec835a', approved: '#0ca30c', rejected: '#d03b3b'};
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
if (window.Chart) {Chart.defaults.font.family = 'Segoe UI, system-ui, sans-serif'; Chart.defaults.color = MUTED; Chart.defaults.plugins.legend.display = false}
const charts = {};
const compact = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K' : v;
function axes(horizontal) {
  const val = {beginAtZero: true, grid: {color: GRID}, border: {display: false}, ticks: {precision: 0, callback: compact}};
  const cat = {grid: {display: false}, border: {color: '#c3c2b7'}, ticks: {color: INK, autoSkip: !horizontal}};
  return horizontal ? {x: val, y: cat} : {x: cat, y: val};
}
function draw(id, type, labels, data, opts = {}) {
  charts[id] && charts[id].destroy();
  const horizontal = !!opts.horizontal;
  const ds = type === 'line'
    ? {data, borderColor: SERIES, backgroundColor: 'rgba(42,120,214,.10)', fill: true, borderWidth: 2, tension: .25, pointRadius: 4, pointBackgroundColor: SERIES, pointBorderColor: '#fff', pointBorderWidth: 2, pointHoverRadius: 6}
    : {data, backgroundColor: opts.colors || SERIES, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24};
  charts[id] = new Chart($(id), {type, data: {labels, datasets: [{label: opts.label || '', ...ds}]},
    options: {indexAxis: horizontal ? 'y' : 'x', maintainAspectRatio: false, animation: {duration: 250}, interaction: {mode: 'index', intersect: false},
      scales: axes(horizontal), plugins: {tooltip: {backgroundColor: '#0f172a', padding: 10, displayColors: false}}}});
}
function table(id, head, rows) {
  $(id).innerHTML = '<table><thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    (rows.length ? rows.map(r => '<tr>' + r.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('') : '<tr><td colspan="' + head.length + '">' + T('no_data') + '</td></tr>') + '</tbody></table>';
}
document.querySelectorAll('.tbl-toggle').forEach(b => b.onclick = () => {
  const card = b.closest('.chart-card'), tbl = card.querySelector('.ch-table'), body = card.querySelector('.ch-body');
  tbl.hidden = !tbl.hidden; body.hidden = !tbl.hidden; b.textContent = tbl.hidden ? T('table') : T('chart');
});
function setOvRange(days) {$('ovFrom').value = daysAgo(days); $('ovTo').value = daysAgo(0)}
document.querySelectorAll('[data-ovrange]').forEach(b => b.onclick = () => {setOvRange(+b.dataset.ovrange); loadOverview()});
$('ovApply').onclick = () => loadOverview();
const WEEKDAYS = () => T('weekdays').split(',');  // пн..вс
async function loadOverview() {
  if (!$('ovFrom').value) setOvRange(29);
  const d = await getJSON('/api/admin/overview?from=' + $('ovFrom').value + '&to=' + $('ovTo').value);
  // заполняем пропущенные дни нулями, чтобы ось времени была честной
  const days = [], map = Object.fromEntries(d.per_day.map(x => [x.day, x]));
  for (let t = new Date(d.range[0] + 'T00:00:00'); iso(t) <= d.range[1]; t.setDate(t.getDate() + 1)) days.push(iso(t));
  const short = s => s.slice(5).split('-').reverse().join('.');
  draw('chActivity', 'bar', days.map(short), days.map(x => (map[x] || {}).n || 0), {label: T('ch_events')});
  table('tActivity', [T('col_date'), T('ch_events'), T('ch_devices_short')], days.map(x => [x, (map[x] || {}).n || 0, (map[x] || {}).devices || 0]));
  draw('chDevices', 'line', days.map(short), days.map(x => (map[x] || {}).devices || 0), {label: T('ch_devices_short')});
  table('tDevices', [T('col_date'), T('ch_devices_short')], days.map(x => [x, (map[x] || {}).devices || 0]));
  draw('chActions', 'bar', d.by_action.map(x => T('act_' + x.action)), d.by_action.map(x => x.n), {horizontal: true});
  table('tActions', [T('col_action'), T('ch_events')], d.by_action.map(x => [T('act_' + x.action), x.n]));
  draw('chUsers', 'bar', d.top_users.map(x => x.user + ' · ' + x.host), d.top_users.map(x => x.n), {horizontal: true});
  table('tUsers', [T('col_employee'), T('col_pc'), T('ch_events')], d.top_users.map(x => [x.user, x.host, x.n]));
  draw('chOs', 'bar', d.os.map(x => x.label), d.os.map(x => x.n), {horizontal: true});
  table('tOs', [T('col_os'), T('ch_devices_short')], d.os.map(x => [x.label, x.n]));
  draw('chBrowsers', 'bar', d.browsers.map(x => x.label), d.browsers.map(x => x.n), {horizontal: true});
  table('tBrowsers', [T('col_browser'), T('ch_devices_short')], d.browsers.map(x => [x.label, x.n]));
  const st = ['pending', 'resubmitted', 'changes', 'approved', 'rejected'], stMap = Object.fromEntries(d.sub_status.map(x => [x.status, x.n]));
  draw('chSubStatus', 'bar', st.map(s => T('st_' + s)), st.map(s => stMap[s] || 0), {horizontal: true, colors: st.map(s => STATUS_COLORS[s])});
  table('tSubstatus', [T('col_status'), T('col_count')], st.map(s => [T('st_' + s), stMap[s] || 0]));
  // тепловая карта: дни недели × часы, одна шкала синего
  const grid = {}; let max = 0;
  d.heat.forEach(x => {const wd = (x.wd + 6) % 7; grid[wd + '_' + x.hr] = x.n; max = Math.max(max, x.n)});
  const wds = WEEKDAYS();
  let html = '<table><thead><tr><th></th>' + Array.from({length: 24}, (_, h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
  for (let w = 0; w < 7; w++) {
    html += '<tr><th>' + esc(wds[w]) + '</th>';
    for (let h = 0; h < 24; h++) {
      const n = grid[w + '_' + h] || 0, step = n ? RAMP[Math.min(RAMP.length - 1, Math.floor(n / max * (RAMP.length - 1)))] : '#f1f5f9';
      html += '<td style="background:' + step + '" title="' + esc(wds[w]) + ' ' + h + ':00 · ' + n + ' ' + T('ch_events_lc') + '"></td>';
    }
    html += '</tr>';
  }
  $('heat').innerHTML = html + '</tbody></table><div class="heat-legend">0 <span style="background:#f1f5f9"></span>' + RAMP.filter((_, i) => i % 3 === 0).map(c => '<span style="background:' + c + '"></span>').join('') + ' ' + max + '</div>';
  const maxDoc = Math.max(1, ...d.top_docs.map(x => x.n));
  $('topDocs').innerHTML = d.top_docs.length ? '<table class="docs"><thead><tr><th>' + T('col_document') + '</th><th>' + T('ch_requests') + '</th><th>' + T('col_pcs') + '</th><th></th></tr></thead><tbody>' +
    d.top_docs.map(x => '<tr><td><b>' + esc(x.doc_name) + '</b><div class="small">' + esc(x.path) + '</div></td><td class="num">' + x.n + '</td><td class="num">' + x.machines + '</td><td class="barcell"><div class="bar" style="width:' + (x.n / maxDoc * 100) + '%"></div></td></tr>').join('') + '</tbody></table>'
    : '<div class="empty-note">' + T('no_data') + '</div>';
}
loaders.overview = loadOverview;

// ---------- Подключения ----------
let devicesCache = [];
async function loadActive() {
  const d = await getJSON('/api/admin/active');
  $('activeRows').innerHTML = d.active.length ? d.active.map(s => '<tr><td><b>' + esc(s.user) + '</b></td><td>' + esc(s.host) + '</td><td>' + esc(s.ip) + '</td><td>' + esc(s.os) + '</td><td>' + esc(s.browser) + '</td><td>' + esc(s.since) + '</td><td>' + T('sec_ago', {n: s.idle}) + '</td><td class="wrap">' + esc(s.doc || '—') + '</td><td class="nowrap">' + devButtons(s) + '</td></tr>').join('')
    : '<tr><td colspan="9">' + T('nobody_online') + '</td></tr>';
  bindDevButtons($('activeRows'), d.active);
}
loaders.active = loadActive;
const devButtons = s => '<button class="icon" data-msg="' + esc(s.client_id) + '" title="' + T('write_message') + '">✉</button><button class="icon danger" data-block="' + esc(s.client_id) + '" title="' + T('block') + '">⛔</button>';
function bindDevButtons(root, list) {
  const byId = Object.fromEntries(list.map(x => [x.client_id, x]));
  root.querySelectorAll('[data-msg]').forEach(b => b.onclick = () => messageDialog(byId[b.dataset.msg]));
  root.querySelectorAll('[data-block]').forEach(b => b.onclick = () => blockDialog(byId[b.dataset.block]));
  root.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => {resetLog(); $('host').value = b.dataset.hist; showTab('log')});
}

// ---------- Сотрудники ----------
async function loadDevices() {
  const d = await getJSON('/api/admin/devices?q=' + encodeURIComponent($('devQ').value));
  devicesCache = d.items;
  $('devRows').innerHTML = d.items.length ? d.items.map(x => {
    const many = x.host_names.length > 1 || x.names.length > 1;
    const names = [...new Set([...x.names, ...x.host_names])];
    return '<tr class="' + (x.blocked ? 'blocked' : '') + '"><td>' + (x.blocked ? '⛔' : '<span class="dot ' + (x.online ? 'on' : '') + '"></span>') + '</td><td><b>' + esc(x.user || '—') + '</b>' +
      (many ? ' <span class="warn-badge" title="' + esc(T('many_names') + ': ' + names.join(', ')) + '">⚠ ' + names.length + '</span>' : '') + '</td><td>' + esc(x.host) + '</td><td>' + esc(x.ip) + '</td><td>' + esc(x.os) + '</td><td>' + esc(x.browser) + '</td><td>' + esc(x.screen) + '</td><td>' + esc(x.first_seen) + '</td><td>' + esc(x.last_seen) + '</td><td class="num">' + x.visits + '</td>' +
      '<td class="nowrap">' + devButtons(x) + '<button class="icon" data-hist="' + esc(x.host) + '" title="' + T('history') + '">📜</button></td></tr>';
  }).join('') : '<tr><td colspan="11">' + T('no_data') + '</td></tr>';
  bindDevButtons($('devRows'), d.items);
}
loaders.devices = loadDevices;
let devTimer; $('devQ').oninput = () => {clearTimeout(devTimer); devTimer = setTimeout(loadDevices, 300)};
$('devNewMsg').onclick = () => pickDevice(messageDialog);
$('msgNew').onclick = () => pickDevice(messageDialog);

async function pickDevice(then) {
  if (!devicesCache.length) devicesCache = (await getJSON('/api/admin/devices')).items;
  modal('<h3>' + T('choose_recipient') + '</h3><input id="pdQ" placeholder="' + T('dev_search_ph') + '"><div class="pick" id="pdList"></div><div class="actions"><button data-close>' + T('cancel') + '</button></div>', (back, close) => {
    const render = () => {
      const q = back.querySelector('#pdQ').value.toLowerCase();
      const list = devicesCache.filter(x => [x.user, x.host, x.ip].join(' ').toLowerCase().includes(q)).slice(0, 100);
      back.querySelector('#pdList').innerHTML = list.map(x => '<button data-cid="' + esc(x.client_id) + '"><b>' + esc(x.user || '—') + '</b> · ' + esc(x.host) + ' · ' + esc(x.ip) + '</button>').join('') || '<div class="empty-note">' + T('no_data') + '</div>';
      back.querySelectorAll('[data-cid]').forEach(b => b.onclick = () => {close(); then(devicesCache.find(x => x.client_id === b.dataset.cid))});
    };
    back.querySelector('#pdQ').oninput = render; render(); back.querySelector('#pdQ').focus();
  });
}

function messageDialog(dev, submissionId) {
  modal('<h3>✉ ' + T('message_to', {user: esc(dev.user || '—'), host: esc(dev.host)}) + '</h3><textarea id="mText" rows="5" placeholder="' + T('msg_ph') + '"></textarea>' +
    '<label class="check"><input type="checkbox" id="mImp" checked> ' + T('msg_important') + '</label><div class="err" id="mErr"></div>' +
    '<div class="actions"><button data-close>' + T('cancel') + '</button><button class="primary" id="mSend">' + T('send') + '</button></div>', (back, close) => {
    back.querySelector('#mText').focus();
    back.querySelector('#mSend').onclick = async () => {
      const r = await postJSON('/api/admin/messages', {client_id: dev.client_id, text: back.querySelector('#mText').value, important: back.querySelector('#mImp').checked, submission_id: submissionId || null});
      if (r.ok) {close(); toast(T('msg_sent')); if (currentTab === 'msgs') loadConvs(dev.client_id)} else back.querySelector('#mErr').textContent = r.error;
    };
  });
}

// ---------- Блокировки ----------
function blockDialog(dev) {
  dev = dev || {user: '', ip: '', host: '', client_id: ''};
  const manual = !dev.client_id;
  modal('<h3>⛔ ' + T('block_title') + '</h3><div class="small">' + T('block_rule') + '</div>' +
    (manual ? '<label>IP<input id="bIp"></label><label>' + T('col_pc') + '<input id="bHost"></label><label>' + T('col_employee') + '<input id="bUser"></label>'
      : '<p><b>' + esc(dev.user || '—') + '</b></p><label class="check"><input type="checkbox" id="bUseIp" checked> IP: ' + esc(dev.ip) + '</label>' +
        '<label class="check"><input type="checkbox" id="bUseHost"' + (dev.host && dev.host !== dev.ip ? ' checked' : ' disabled') + '> ' + T('col_pc') + ': ' + esc(dev.host) + '</label>' +
        '<label class="check"><input type="checkbox" id="bUseCid" checked> ' + T('col_browser_id') + ': ' + esc(dev.client_id.slice(0, 8)) + '…</label>') +
    '<label>' + T('reason') + '<input id="bReason" maxlength="300" placeholder="' + T('reason_ph') + '"></label><label>' + T('blocked_until') + ' <span class="small">(' + T('until_empty') + ')</span><input type="date" id="bUntil"></label>' +
    '<div class="err" id="bErr"></div><div class="actions"><button data-close>' + T('cancel') + '</button><button class="danger-btn" id="bSave">' + T('block') + '</button></div>', (back, close) => {
    back.querySelector('#bSave').onclick = async () => {
      const g = id => back.querySelector(id);
      const body = manual ? {ip: g('#bIp').value, host: g('#bHost').value, user: g('#bUser').value}
        : {ip: dev.ip, host: dev.host, client_id: dev.client_id, user: dev.user, use_ip: g('#bUseIp').checked, use_host: g('#bUseHost').checked, use_cid: g('#bUseCid').checked};
      const r = await postJSON('/api/admin/blocks', {...body, reason: g('#bReason').value, until: g('#bUntil').value});
      if (r.ok) {close(); toast(T('blocked_ok')); loaders[currentTab] && loaders[currentTab]()} else g('#bErr').textContent = r.error;
    };
  });
}
async function loadBlocks() {
  const d = await getJSON('/api/admin/blocks');
  $('blkRows').innerHTML = d.items.length ? d.items.map(b => '<tr class="' + (b.active ? 'blocked' : 'muted') + '"><td>' + (b.active ? '⛔ ' + T('active') : T('removed')) + '</td><td>' + esc(b.user || '—') + '</td><td>' + esc(b.ip || '—') + '</td><td>' + esc(b.host || '—') + '</td><td>' + esc(b.client_id ? b.client_id.slice(0, 8) + '…' : '—') + '</td><td class="wrap">' + esc(b.reason || '') + '</td><td>' + esc(b.created_at) + '</td><td>' + esc(b.until ? b.until.slice(0, 10) : T('forever')) + '</td><td>' + (b.active ? '<button data-unblock="' + b.id + '">' + T('unblock') + '</button>' : esc(b.removed_at || '')) + '</td></tr>').join('')
    : '<tr><td colspan="9">' + T('no_blocks') + '</td></tr>';
  $('blkRows').querySelectorAll('[data-unblock]').forEach(b => b.onclick = async () => {if (confirm(T('confirm_unblock'))) {await postJSON('/api/admin/blocks/' + b.dataset.unblock + '/remove', {}); loadBlocks()}});
}
loaders.blocks = loadBlocks;
$('blkAdd').onclick = () => blockDialog(null);

// ---------- Заявки ----------
let subStatus = '';
async function loadSubs(filter) {
  if (filter !== undefined) subStatus = filter;
  document.querySelectorAll('#subFilter [data-st]').forEach(b => b.classList.toggle('active', b.dataset.st === subStatus));
  const d = await getJSON('/api/admin/submissions?status=' + subStatus);
  $('subRows').innerHTML = d.items.length ? d.items.map(s => '<tr class="clickable st-row-' + s.status + '" data-sub="' + s.id + '"><td>' + s.id + '</td><td>' + statusBadge(s.status) + (s.unread ? ' <span class="badge purple">' + s.unread + '</span>' : '') + '</td><td><b>' + esc(s.title) + '</b>' + (s.has_exec ? ' <span class="warn-badge">⚠ ' + T('exec_file') + '</span>' : '') + '<div class="small clip">' + esc(s.description) + '</div></td><td>' + esc(s.user) + '</td><td>' + esc(s.host) + '<div class="small">' + esc(s.ip) + '</div></td><td class="num">' + s.files.length + '</td><td class="small">' + esc([s.documentation, s.rfq, s.system, s.unit].filter(Boolean).join(' / ') || '—') + '</td><td>' + esc(s.updated_at) + '</td></tr>').join('')
    : '<tr><td colspan="8">' + T('no_submissions') + '</td></tr>';
  $('subRows').querySelectorAll('[data-sub]').forEach(tr => tr.onclick = () => openSub(+tr.dataset.sub));
}
loaders.subs = loadSubs;
document.querySelectorAll('#subFilter [data-st]').forEach(b => b.onclick = () => loadSubs(b.dataset.st));

async function openSub(id) {
  const s = await getJSON('/api/admin/submissions/' + id);
  const open = ['pending', 'resubmitted', 'changes'].includes(s.status);
  const fld = (k, label, area) => '<label' + (area ? ' class="full"' : '') + '>' + label + (area ? '<textarea data-f="' + k + '" rows="' + (k === 'description' ? 4 : 2) + '">' + esc(s[k]) + '</textarea>' : '<input data-f="' + k + '" value="' + esc(s[k]) + '">') + '</label>';
  const scanLabel = r => r ? '<span class="scan scan-' + r + '">' + T('scan_' + r) + '</span>' : '';
  modal('<div class="modal-head"><h3>📥 #' + s.id + ' ' + esc(s.title) + ' ' + statusBadge(s.status) + '</h3><button data-close class="x">✕</button></div>' +
    '<div class="small">' + T('submitted_by', {user: esc(s.user), host: esc(s.host), ip: esc(s.ip), ts: esc(s.created_at)}) + '</div>' +
    '<div class="sub-layout"><div><div class="form-grid">' + fld('title', T('fld_title')) + fld('doc_type', T('fld_doc_type')) + fld('description', T('fld_description'), true) + fld('revision', T('fld_revision')) +
    fld('documentation', T('f_documentation')) + fld('rfq', 'RFQ') + fld('system', T('f_system')) + fld('unit', 'UNIT') + fld('comment', T('fld_comment'), true) + '</div>' +
    '<div class="actions"><button id="sSave">💾 ' + T('save_changes') + '</button></div>' +
    '<h4>' + T('col_files') + '</h4><div class="filelist">' + s.files.map(f => '<div class="fileitem' + (f.exec ? ' exec' : '') + '">📄 ' + esc(f.orig_name) + ' <span class="small">' + fmtSize(f.size) + '</span> ' + (f.exec ? '<span class="warn-badge">⚠ ' + T('exec_file') + '</span> ' : '') + scanLabel(f.scan) +
      '<button data-pv="' + f.id + '">👁 ' + T('preview') + '</button><button data-dl="' + f.id + '">⤓</button></div>').join('') + '</div>' +
    (s.approved_paths.length ? '<div class="note ok">' + T('approved_to') + '<br>' + s.approved_paths.map(esc).join('<br>') + '</div>' : '') +
    '<div class="preview sub-preview" id="sPreview"><div class="msg">' + T('choose_file_preview') + '</div></div></div>' +
    '<div class="sub-side"><h4>' + T('conversation') + '</h4><div class="thread" id="sThread">' + (s.messages.length ? s.messages.map(m => '<div class="bubble ' + (m.sender === 'admin' ? 'me' : 'user') + '"><div class="bmeta">' + (m.sender === 'admin' ? '🛡 admin' : '👤 ' + esc(m.user)) + ' · ' + esc(m.ts) + '</div>' + esc(m.text) + '</div>').join('') : '<div class="empty-note">' + T('no_messages') + '</div>') + '</div>' +
    '<textarea id="sText" rows="4" placeholder="' + T('sub_msg_ph') + '"></textarea><div class="err" id="sErr"></div>' +
    '<div class="actions vertical">' +
    (open ? '<button class="ok-btn" id="sApprove"' + (CAN_APPROVE ? '' : ' disabled title="' + T('sub_err_server_only') + '"') + '>✓ ' + T('approve') + '</button>' + (CAN_APPROVE ? '' : '<div class="small">' + T('approve_server_only_note') + '</div>') +
      '<button class="warn-btn" id="sChanges">↩ ' + T('request_changes') + '</button><button class="danger-btn" id="sReject">✕ ' + T('reject') + '</button>' : '') +
    '<button id="sMsg">✉ ' + T('send_message_only') + '</button><button class="link-danger" id="sDelete">🗑 ' + T('delete_submission') + '</button></div></div></div>', (back, close) => {
    const err = back.querySelector('#sErr'), text = () => back.querySelector('#sText').value.trim();
    const th = back.querySelector('#sThread'); th.scrollTop = th.scrollHeight;
    const fields = () => Object.fromEntries([...back.querySelectorAll('[data-f]')].map(i => [i.dataset.f, i.value]));
    const after = msg => {close(); toast(msg); loadSubs(); refreshCards()};
    back.querySelector('#sSave').onclick = async () => {const r = await postJSON('/api/admin/submissions/' + id, fields()); r.ok ? toast(T('saved')) : err.textContent = r.error};
    back.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => {const f = s.files.find(x => x.id === +b.dataset.pv); Portal.preview(back.querySelector('#sPreview'), {...f, name: f.orig_name}, {url: '/api/admin/files/' + f.id + '/preview', noActions: true})});
    back.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {const f = s.files.find(x => x.id === +b.dataset.dl); Portal.download({...f, name: f.orig_name}, '/api/admin/files/' + f.id + '/raw?download=1')});
    const act = async (action, body, okMsg) => {
      await postJSON('/api/admin/submissions/' + id, fields());  // сначала сохраняем правки администратора
      const r = await postJSON('/api/admin/submissions/' + id + '/' + action, body);
      if (r.ok) return after(okMsg + (r.paths ? '\n' + r.paths.join('\n') : ''));
      if (r.code === 'sub_err_unscanned' && confirm(r.error + '\n\n' + T('approve_without_scan'))) return act(action, {...body, allow_unscanned: true}, okMsg);
      err.textContent = r.error;
    };
    const q = sel => back.querySelector(sel);
    if (q('#sApprove')) q('#sApprove').onclick = () => {if (confirm(T('confirm_approve'))) act('approve', {text: text()}, T('approved_ok'))};
    if (q('#sChanges')) q('#sChanges').onclick = () => {if (!text()) {err.textContent = T('changes_need_text'); q('#sText').focus(); return} act('changes', {text: text()}, T('changes_ok'))};
    if (q('#sReject')) q('#sReject').onclick = () => {if (confirm(T('confirm_reject'))) act('reject', {text: text()}, T('rejected_ok'))};
    q('#sMsg').onclick = async () => {if (!text()) {err.textContent = T('msg_err_empty'); return} const r = await postJSON('/api/admin/messages', {client_id: s.client_id, text: text(), submission_id: id, important: true}); r.ok ? after(T('msg_sent')) : err.textContent = r.error};
    q('#sDelete').onclick = () => {if (confirm(T('confirm_delete_sub'))) act('delete', {}, T('deleted'))};
  }, null, 'xwide');
}

// ---------- Сообщения ----------
async function loadConvs(openCid) {
  const d = await getJSON('/api/admin/conversations');
  $('convs').innerHTML = d.items.length ? d.items.map(c => '<button class="conv' + (c.unread ? ' unread' : '') + '" data-cid="' + esc(c.client_id) + '"><div><b>' + esc(c.user || '—') + '</b> · ' + esc(c.host) + (c.unread ? ' <span class="badge purple">' + c.unread + '</span>' : '') + '</div><div class="small clip">' + (c.last.sender === 'admin' ? '🛡 ' : '👤 ') + esc(c.last.text) + '</div><div class="small">' + esc(c.last.ts) + '</div></button>').join('')
    : '<div class="empty-note">' + T('no_messages') + '</div>';
  $('convs').querySelectorAll('[data-cid]').forEach(b => b.onclick = () => openConv(b.dataset.cid));
  if (openCid) openConv(openCid);
}
async function openConv(cid) {
  document.querySelectorAll('#convs .conv').forEach(b => b.classList.toggle('active', b.dataset.cid === cid));
  const d = await getJSON('/api/admin/conversations/' + encodeURIComponent(cid));
  const dev = d.device || {client_id: cid, user: '—', host: '', ip: ''};
  $('convThread').innerHTML = '<div class="ch-head"><h3>' + esc(dev.user || '—') + ' · ' + esc(dev.host) + ' · ' + esc(dev.ip) + '</h3><span class="small">' + esc(dev.os || '') + ' ' + esc(dev.browser || '') + '</span></div>' +
    '<div class="thread" id="cThread">' + d.items.map(m => '<div class="bubble ' + (m.sender === 'admin' ? 'me' : 'user') + (m.important ? ' important' : '') + '"><div class="bmeta">' + (m.sender === 'admin' ? '🛡 admin' : '👤 ' + esc(m.user)) + ' · ' + esc(m.ts) + (m.submission_id ? ' · <a href="#" data-opensub="' + m.submission_id + '">#' + m.submission_id + ' ' + esc(m.submission_title || '') + '</a>' : '') + '</div>' + esc(m.text) + '</div>').join('') + '</div>' +
    '<textarea id="cText" rows="3" placeholder="' + T('msg_ph') + '"></textarea><label class="check"><input type="checkbox" id="cImp"> ' + T('msg_important') + '</label><div class="err" id="cErr"></div><div class="actions"><button class="primary" id="cSend">' + T('send') + '</button></div>';
  const th = $('cThread'); th.scrollTop = th.scrollHeight;
  $('convThread').querySelectorAll('[data-opensub]').forEach(a => a.onclick = e => {e.preventDefault(); openSub(+a.dataset.opensub)});
  $('cSend').onclick = async () => {
    const r = await postJSON('/api/admin/messages', {client_id: cid, text: $('cText').value, important: $('cImp').checked});
    r.ok ? loadConvs(cid) : $('cErr').textContent = r.error;
  };
  refreshCards();
}
loaders.msgs = () => loadConvs();

// ---------- Журнал ----------
$('action').innerHTML += ACTIONS.map(k => '<option value="' + k + '">' + esc(T('act_' + k)) + '</option>').join('');
let page = 1;
function setRange(days) {if (days === 'all') {$('from').value = $('to').value = ''} else {$('from').value = daysAgo(+days); $('to').value = daysAgo(0)}}
function resetLog() {['host', 'user', 'ip', 'action', 'q'].forEach(k => $(k).value = ''); setRange(29); page = 1}
function params() {const p = new URLSearchParams({page}); ['from', 'to', 'host', 'user', 'ip', 'action', 'q'].forEach(k => $(k).value && p.set(k, $(k).value)); return p}
async function loadEvents(filter) {
  if (filter === 'security') {resetLog(); setRange(0); $('action').value = 'admin_login_fail'}
  const d = await getJSON('/api/admin/events?' + params());
  $('total').textContent = T('found_n', {n: d.total.toLocaleString()});
  $('events').innerHTML = d.rows.map(r => '<tr><td class="nowrap">' + esc(r.ts) + '</td><td>' + esc(r.host) + '</td><td>' + esc(r.user) + '</td><td>' + esc(r.ip) + '</td><td><span class="act act-' + esc(r.action) + '">' + esc(T('act_' + r.action)) + '</span></td><td class="wrap">' + esc(r.doc_name || r.details) + '</td><td class="wrap small">' + esc(r.path) + '</td></tr>').join('') || '<tr><td colspan="7">' + T('no_data') + '</td></tr>';
  $('pageInfo').textContent = T('page_of', {page: d.page, pages: d.pages}); $('prev').disabled = d.page <= 1; $('next').disabled = d.page >= d.pages;
}
loaders.log = loadEvents;
document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {setRange(b.dataset.range); page = 1; loadEvents()});
$('apply').onclick = () => {page = 1; loadEvents()};
document.querySelectorAll('[data-pane="log"] .filters input').forEach(i => i.addEventListener('keydown', e => {if (e.key === 'Enter') {page = 1; loadEvents()}}));
$('prev').onclick = () => {page--; loadEvents()}; $('next').onclick = () => {page++; loadEvents()};
$('csv').onclick = () => {const p = params(); p.delete('page'); location.href = '/api/admin/events.csv?' + p};
setRange(29);

// ---------- Настройки ----------
$('pwForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target), r = await postJSON('/api/admin/password', Object.fromEntries(f));
  if (r.ok) {e.target.reset(); $('pwErr').textContent = ''; toast(T('pw_changed'))} else $('pwErr').textContent = r.error;
};
async function loadSystem() {
  const d = await getJSON('/api/admin/system');
  const row = (label, ok, value) => '<tr><td>' + (ok ? '✅' : '⚠️') + ' ' + label + '</td><td>' + esc(value) + '</td></tr>';
  $('sysInfo').innerHTML = '<table class="sys">' + row(T('sys_root'), true, d.root) + row(T('sys_share'), !!d.share, d.share || T('sys_not_set')) +
    row(T('sys_writable'), d.writable, d.writable ? T('yes') : T('sys_not_writable')) + row('LibreOffice', !!d.soffice, d.soffice || T('sys_missing')) + row('ffmpeg', !!d.ffmpeg, d.ffmpeg || T('sys_missing')) +
    row('Pillow', d.pillow, d.pillow ? T('yes') : T('sys_missing')) + row('Windows Defender', !!d.defender, d.defender || T('sys_missing')) +
    row(T('sys_upload_max'), true, d.upload_max + ' MB') + row(T('sys_pw_changed'), true, d.pw_changed.value || '—') + '</table>' +
    '<h4>' + T('sys_allowed') + '</h4><div class="small exts">' + d.allowed.map(e => '<span class="' + (d.exec.includes(e) ? 'exec' : '') + '">' + esc(e) + '</span>').join(' ') + '</div><div class="small">' + T('sys_allowed_note') + '</div>';
}
loaders.settings = loadSystem;

// ---------- Старт ----------
refreshCards(); setInterval(refreshCards, 15000);
setInterval(() => {if (currentTab === 'active') loadActive()}, 5000);
const startTab = location.hash.slice(1);
showTab(startTab in loaders ? startTab : 'overview');
