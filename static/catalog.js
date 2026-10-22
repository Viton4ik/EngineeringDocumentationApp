// Главная страница каталога: таблица, фильтры, дерево папок, предпросмотр справа.
const {esc, fmtSize, T} = Portal;
const ICON = {pdf: '📕', word: '📘', excel: '📗', powerpoint: '📙', visio: '📐', image: '🖼', video: '🎬', audio: '🎵', text: '📄', archive: '🗜', mail: '✉', cad: '📏', other: '📎'};
const MAX_ROWS = 3000;
let files = [], byId = new Map(), filtered = [], selected = null, checked = new Set(), sortKey = 'relative', sortDir = 1, folderFilter = '', favoritesOnly = false, titlesVersion = 0, titlesTimer = null;
let favorites = new Set(JSON.parse(Portal.store.get('doc-favorites', '[]')));
const $ = id => document.getElementById(id);
const saveFav = () => Portal.store.set('doc-favorites', JSON.stringify([...favorites]));
const IS_ADMIN = !!window.IS_ADMIN;
const seenMoves = new Set(JSON.parse(Portal.store.get('doc-seen-moves', '[]')));

async function load(rescan = false) {
  $('rows').innerHTML = '<tr><td colspan="12" class="empty">' + T('loading') + '</td></tr>';
  try {
    if (rescan) {const status = await (await Portal.api('/api/refresh', {method: 'POST'})).json(); if (status.error) alert(status.error)}
    const d = await (await Portal.api('/api/files')).json();
    files = d.files || []; window.CATALOG_FILES = files; window.CATALOG_FOLDERS = d.folders || []; byId = new Map(files.map(f => [f.id, f])); titlesVersion = d.titles_version || 0;
    $('simcount').textContent = (d.siemens_count || 0);
    buildFilters(); renderTree(); applyFilters();
    $('updated').textContent = $('created').textContent = (d.scanned_at || '—').replace('T', ' ');
    pollTitles(); checkMoves();
  } catch (e) {$('rows').innerHTML = '<tr><td colspan="12" class="empty">' + esc(e.message) + '</td></tr>'}
}

// Названия документов распознаются на сервере в фоне, одобренные заявки добавляются туда же; берём только изменения.
async function pollTitles() {
  clearTimeout(titlesTimer);
  try {
    const d = await (await Portal.api('/api/titles?since=' + titlesVersion)).json();
    let added = false;
    d.changes.forEach(([id, title, source, rec]) => {
      if (source === 'moved') {  // перенос: убираем старую запись, добавляем новую, избранное и выбор следуют за файлом
        const i = files.findIndex(f => f.id === id); if (i >= 0) files.splice(i, 1); byId.delete(id);
        if (rec && !byId.has(rec.id)) {files.push(rec); byId.set(rec.id, rec)}
        if (favorites.has(id) && rec) {favorites.delete(id); favorites.add(rec.id); saveFav()}
        if (checked.delete(id) && rec) checked.add(rec.id);
        if (selected && selected.id === id && rec) {selected = null; setTimeout(() => choose(rec.id), 0)}
        addFolder(rec); added = true; return;
      }
      const f = byId.get(id);
      if (f) {f.doc_name = title; f.title_source = source}
      else if (rec) {files.push(rec); byId.set(rec.id, rec); addFolder(rec); added = true}
    });
    if (d.changes.length) {titlesVersion += d.changes.length; if (added) {buildFilters(); renderTree()} applyFilters(true)}
    $('titlesProgress').textContent = d.running ? T('titles_progress', {done: d.done, total: d.total, found: d.found}) : '';
    titlesTimer = setTimeout(pollTitles, d.running ? 4000 : titlesVersion < d.version ? 200 : 30000);
  } catch {titlesTimer = setTimeout(pollTitles, 30000)}
}

function addFolder(rec) {
  if (!rec) return;
  let p = ''; Portal.relFolder(rec).split('/').filter(Boolean).forEach(x => {p = p ? p + '/' + x : x; if (!window.CATALOG_FOLDERS.includes(p)) window.CATALOG_FOLDERS.push(p)});
}

// Перенесённые документы: окно для тех, у кого они в избранном, и полоса «Перенесено за 7 дней».
async function checkMoves() {
  let items = [];
  try {items = (await (await Portal.api('/api/moves/recent?days=90')).json()).items} catch {return}
  const fresh = items.filter(m => (favorites.has(m.old_path) || favorites.has(m.new_path)) && !seenMoves.has(m.id));
  items.forEach(m => {if (favorites.has(m.old_path)) {favorites.delete(m.old_path); favorites.add(m.new_path)}});
  saveFav();
  if (fresh.length && !document.querySelector('.modal-back')) {
    fresh.forEach(m => seenMoves.add(m.id)); Portal.store.set('doc-seen-moves', JSON.stringify([...seenMoves].slice(-500)));
    Portal.movedNotice(fresh);
  }
  const week = items.filter(m => (Date.now() - new Date(m.ts.replace(' ', 'T'))) < 7 * 864e5);
  const bar = $('movedBar');
  bar.hidden = !week.length;
  if (week.length) {bar.innerHTML = '⇄ ' + T('moved_week', {n: week.length}) + ' <a href="#">' + T('show') + '</a>'; bar.querySelector('a').onclick = e => {e.preventDefault(); Portal.movedNotice(week)}}
}

function fillSelect(id, key) {
  let el = $(id), old = el.value, vals = [...new Set(files.map(f => f[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ru', {numeric: true}));
  el.innerHTML = '<option value="">' + (id === 'ext' ? T('all_types') : T('all')) + '</option>' + vals.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
  if (vals.includes(old)) el.value = old;
}
function buildFilters() {[['ext', 'extension'], ['documentation', 'documentation'], ['rfq', 'rfq'], ['system', 'system'], ['unit', 'unit']].forEach(x => fillSelect(...x))}
function renderTree() {
  let folders = new Map();
  files.forEach(f => {let parts = f.relative.split(/[\\/]/); parts.pop(); let p = ''; parts.forEach(part => {p = p ? p + '/' + part : part; folders.set(p, (folders.get(p) || 0) + 1)})});
  let arr = [...folders.keys()].sort((a, b) => a.localeCompare(b, 'ru', {numeric: true}));
  $('tree').innerHTML = '<button data-folder="">▦ ' + T('all_folders') + ' <span class="tree-count">' + files.length + '</span></button>' + arr.map(p => '<button data-folder="' + esc(p) + '" class="' + (folderFilter === p ? 'active' : '') + '">📁 ' + esc(p) + ' <span class="tree-count">' + folders.get(p) + '</span></button>').join('');
  $('tree').querySelectorAll('[data-folder]').forEach(b => b.onclick = () => {folderFilter = b.dataset.folder; renderTree(); applyFilters()});
}
const rel = f => f.relative.replace(/\\/g, '/');
function applyFilters(keepScroll) {
  let q = $('search').value.trim().toLocaleLowerCase(), ext = $('ext').value, doc = $('documentation').value, rfq = $('rfq').value, sys = $('system').value, unit = $('unit').value, date = $('dateFrom').value, min = Number($('minSize').value || 0) * 1024 * 1024;
  filtered = files.filter(f => (!q || [f.name, f.doc_name, f.description, f.relative, f.documentation, f.rfq, f.system, f.unit, f.extension].join(' ').toLocaleLowerCase().includes(q)) && (!ext || f.extension === ext) && (!doc || f.documentation === doc) && (!rfq || f.rfq === rfq) && (!sys || f.system === sys) && (!unit || f.unit === unit) && (!date || f.modified.slice(0, 10) >= date) && f.size >= min && (!folderFilter || rel(f).startsWith(folderFilter + '/')) && (!favoritesOnly || favorites.has(f.id)));
  filtered.sort((a, b) => {let x = a[sortKey] ?? '', y = b[sortKey] ?? ''; let c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru', {numeric: true, sensitivity: 'base'}); return c * sortDir});
  const wrap = document.querySelector('.table-wrap'), top = wrap.scrollTop;
  renderRows(); if (keepScroll === true) wrap.scrollTop = top;
  $('shown').textContent = T('shown', {n: filtered.length, total: files.length}) + (filtered.length > MAX_ROWS ? ' ' + T('shown_capped', {n: MAX_ROWS}) : '');
}
function renderRows() {
  let body = $('rows');
  if (!filtered.length) {body.innerHTML = '<tr><td colspan="12" class="empty">' + T('nothing_found') + '</td></tr>'; return}
  body.innerHTML = filtered.slice(0, MAX_ROWS).map(f => '<tr data-id="' + esc(f.id) + '" class="' + (selected && selected.id === f.id ? 'selected' : '') + (checked.has(f.id) ? ' checked' : '') + '"><td class="chk"><input type="checkbox" data-chk="1"' + (checked.has(f.id) ? ' checked' : '') + ' title="' + T('select_for_move') + '"></td><td><button class="star ' + (favorites.has(f.id) ? 'fav' : '') + '" data-fav="1" title="' + T('favorites') + '">' + (favorites.has(f.id) ? '★' : '☆') + '</button></td><td>' + esc(f.documentation) + '</td><td>' + esc(f.rfq) + '</td><td>' + esc(f.system) + '</td><td>' + esc(f.unit) + '</td><td class="ico" title="' + esc(f.extension) + '">' + (ICON[f.kind] || ICON.other) + '</td><td class="filename" title="' + esc(f.relative) + '">' + esc(f.name) + '</td><td class="filename" title="' + esc(f.description || f.doc_name) + '">' + Portal.srcBadge(f) + esc(f.doc_name) + '</td><td>' + fmtSize(f.size) + '</td><td>' + esc(f.modified.replace('T', ' ')) + '</td><td><button class="row-open" data-open="1" title="' + T('open') + '">↗</button></td></tr>').join('');
}
// Делегирование событий: одна подписка на всю таблицу вместо тысяч.
$('rows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const f = byId.get(tr.dataset.id);
  if (e.target.closest('[data-chk]')) {checked.has(f.id) ? checked.delete(f.id) : checked.add(f.id); tr.classList.toggle('checked', checked.has(f.id)); renderSelection(); return}
  if (e.target.closest('[data-fav]')) {favorites.has(f.id) ? favorites.delete(f.id) : favorites.add(f.id); saveFav(); favoritesOnly ? applyFilters(true) : renderRows(); return}
  if (e.target.closest('[data-open]')) {choose(f.id, true); Portal.openView(f); return}
  choose(f.id);
});
$('rows').addEventListener('dblclick', e => {const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('[data-fav],[data-chk]')) Portal.openView(byId.get(tr.dataset.id))});
document.addEventListener('keydown', e => {
  if (!selected || e.target.matches('input,select,textarea') || document.querySelector('.modal-back')) return;
  if (e.key === 'Enter') {e.preventDefault(); Portal.openView(selected)}
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); const i = filtered.findIndex(f => f.id === selected.id), next = filtered[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {choose(next.id); const tr = document.querySelector('#rows tr.selected'); tr && tr.scrollIntoView({block: 'nearest'})}
  }
});

function choose(id, noPreview) {
  const f = byId.get(id); if (!f) return;
  const changed = !selected || selected.id !== id; selected = f;
  document.querySelectorAll('#rows tr.selected').forEach(tr => tr.classList.remove('selected'));
  const tr = [...document.querySelectorAll('#rows tr[data-id]')].find(t => t.dataset.id === id); tr && tr.classList.add('selected');
  $('preview-title').innerHTML = Portal.srcBadge(f) + esc(f.doc_name || f.name);
  $('preview-actions').innerHTML = Portal.actionsHtml(f, {extra: '<button id="favToggle" title="' + T('favorites') + '">' + (favorites.has(f.id) ? '★' : '☆') + '</button><button id="moveOne" title="' + T(IS_ADMIN ? 'mv_title_admin' : 'mv_title_user') + '">⇄ ' + T(IS_ADMIN ? 'mv_btn_admin' : 'mv_btn_user') + '</button><button id="properties">ⓘ ' + T('properties') + '</button>'});
  $('moveOne').onclick = () => Portal.moveDialog([f], {admin: IS_ADMIN});
  Portal.bindActions($('preview-actions'), f);
  $('favToggle').onclick = () => {favorites.has(f.id) ? favorites.delete(f.id) : favorites.add(f.id); saveFav(); $('favToggle').textContent = favorites.has(f.id) ? '★' : '☆'; favoritesOnly ? applyFilters(true) : renderRows()};
  $('properties').onclick = () => window.open('/document?path=' + encodeURIComponent(f.path), '_blank');
  $('preview-meta').innerHTML = (f.description ? '<div class="desc">' + esc(f.description) + '</div>' : '') + '<b>' + T('col_file') + ':</b> ' + esc(f.name) + ' · ' + fmtSize(f.size) + ' · ' + esc(f.modified.replace('T', ' ')) + '<br><b>' + T('path') + ':</b> ' + esc(Portal.unc(f));
  const box = $('preview-content'); box.style.display = '';
  if (changed && !noPreview) {Portal.preview(box, f); Portal.setCurrentDoc(f.doc_name || f.name)}
}

$('search').addEventListener('input', () => applyFilters());
['ext', 'documentation', 'rfq', 'system', 'unit', 'dateFrom', 'minSize'].forEach(id => $(id).addEventListener('input', () => applyFilters()));
$('refresh').onclick = () => load(true);
$('favoritesOnly').onclick = () => {favoritesOnly = !favoritesOnly; $('favoritesOnly').textContent = favoritesOnly ? '★ ' + T('show_all') : '☆ ' + T('favorites'); applyFilters()};
$('clear').onclick = () => {$('search').value = ''; ['ext', 'documentation', 'rfq', 'system', 'unit', 'dateFrom', 'minSize'].forEach(id => $(id).value = ''); folderFilter = ''; favoritesOnly = false; $('favoritesOnly').textContent = '☆ ' + T('favorites'); renderTree(); applyFilters()};
$('export').onclick = () => {if (confirm(T('confirm_export'))) window.location = '/api/export.csv'};
$('submitBtn').onclick = () => Portal.submitForm(null, files);
function renderSelection() {
  const bar = $('selBar');
  for (const id of [...checked]) if (!byId.has(id)) checked.delete(id);
  bar.hidden = !checked.size;
  $('selCount').textContent = T('selected_n', {n: checked.size});
}
$('selMove').textContent = '⇄ ' + T(IS_ADMIN ? 'mv_btn_admin' : 'mv_btn_user');
$('selMove').onclick = () => Portal.moveDialog([...checked].map(id => byId.get(id)).filter(Boolean), {admin: IS_ADMIN, onDone: () => {checked.clear(); renderSelection(); renderRows()}});
$('selClear').onclick = () => {checked.clear(); renderSelection(); renderRows()};
$('selAll').onclick = () => {filtered.slice(0, MAX_ROWS).forEach(f => checked.add(f.id)); renderSelection(); renderRows()};
document.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {let k = b.dataset.sort; if (sortKey === k) sortDir *= -1; else {sortKey = k; sortDir = 1} applyFilters()});
Portal.startPresence();
load();
