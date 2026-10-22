// Общий код страниц: переводы, присутствие сотрудника, сообщения, заявки, предпросмотр и кнопки открытия.
const Portal = (() => {
  const store = {get(k, d) {try {return localStorage.getItem(k) ?? d} catch {return d}}, set(k, v) {try {localStorage.setItem(k, v)} catch {}}};
  const I18N = window.I18N || {};
  const T = (key, params) => String(I18N[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => params && params[k] != null ? params[k] : m);
  const state = {user: store.get('doc-user', ''), doc: '', page: document.body.dataset.page || ''};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(1) + ' KB' : n < 1024 ** 3 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024 ** 3).toFixed(1) + ' GB';
  async function api(url, opts = {}) {
    const r = await fetch(url, {...opts, headers: {'X-Portal': '1', ...(opts.headers || {})}});
    if (r.status === 403 && !url.startsWith('/api/admin')) {  // администратор заблокировал этот ПК: показываем страницу блокировки
      const d = await r.clone().json().catch(() => ({}));
      if (d.blocked) location.reload();
    }
    return r;
  }
  const post = (url, body) => api(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const log = (action, f, details = '') => post('/api/log', {action, path: f.path, details}).catch(() => {});

  function toast(html, ms = 3500) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = html; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function modal(html, onReady, onClose, cls = '') {
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = '<div class="modal ' + cls + '" role="dialog">' + html + '</div>';
    const close = () => {if (!back.isConnected) return; back.remove(); onClose && onClose()};
    back.addEventListener('click', e => {if (e.target === back || e.target.closest('[data-close]')) close()});
    document.body.appendChild(back); onReady && onReady(back, close);
    return close;
  }
  const srcBadge = f => ({siemens: '<span class="src siemens" title="' + T('src_siemens') + '">SIM</span>', content: '<span class="src content" title="' + T('src_content') + '">' + T('src_content_short') + '</span>',
    approved: '<span class="src approved" title="' + T('src_approved') + '">✓</span>'}[f.title_source] || '');
  const statusBadge = s => '<span class="st st-' + esc(s) + '">' + esc(T('st_' + s)) + '</span>';

  // ---- Сетевой путь: сервер берётся из адресной строки (по IP работает и через Wi-Fi) ----
  const CFG = window.PORTAL || {};
  function unc(f) {
    if (!CFG.share || !f || f.relative == null) return f ? f.unc : '';
    let host = location.hostname;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) host = CFG.host;
    return '\\\\' + host + '\\' + CFG.share + '\\' + String(f.relative).replace(/\//g, '\\');
  }
  const folderUnc = rel => unc({relative: rel ? rel + '/' : '', unc: ''});
  const collate = (a, b) => a.localeCompare(b, 'ru', {numeric: true, sensitivity: 'base'});
  const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const leaf = p => p.slice(p.lastIndexOf('/') + 1);
  const relFolder = f => {const parts = String(f.relative).replace(/\\/g, '/').split('/'); parts.pop(); return parts.join('/')};
  function lev(a, b) {
    const d = Array.from({length: a.length + 1}, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const squash = s => s.toLowerCase().replace(/[\s_\-.]+/g, '');

  // ---- Выбор папки: дерево любой глубины, новые разделы, защита от похожих имён ----
  function folderPicker(root, opts = {}) {
    const all = [...new Set(opts.folders || [])];
    const st = {sel: opts.value || '', open: new Set(), extra: [], adding: null, warn: null, error: '', q: ''};
    const counts = {};
    (opts.files || []).forEach(f => {let p = ''; relFolder(f).split('/').filter(Boolean).forEach(x => {p = p ? p + '/' + x : x; counts[p] = (counts[p] || 0) + 1})});
    const folders = () => all.concat(st.extra);
    const children = parent => folders().filter(p => parentOf(p) === parent).sort(collate);
    const expandTo = p => {for (let a = parentOf(p); a; a = parentOf(a)) st.open.add(a)};
    if (st.sel) {  // папка из прежней заявки может ещё не существовать
      let acc = ''; st.sel.split('/').forEach(x => {acc = acc ? acc + '/' + x : x; if (!all.includes(acc) && !st.extra.includes(acc)) st.extra.push(acc)});
      expandTo(st.sel); st.open.add(st.sel);
    }
    root.innerHTML = '<div class="fp"><div class="fp-left"><input class="fp-find" placeholder="🔍 ' + T('fp_find') + '"><div class="fp-tree"></div></div><div class="fp-side"></div></div>';
    const tree = root.querySelector('.fp-tree'), side = root.querySelector('.fp-side');
    root.querySelector('.fp-find').oninput = e => {st.q = e.target.value; render()};

    function addRow(parent, depth) {
      const pad = 'style="padding-left:' + (8 + depth * 22) + 'px"';
      if (st.adding !== parent) return '<div ' + pad + '><button type="button" class="fp-new" data-add="' + esc(parent) + '">＋ ' + (parent ? T('fp_new_in', {name: esc(leaf(parent))}) : T('fp_new_top')) + '</button></div>';
      let html = '<div class="fp-newrow" ' + pad + '><input class="fp-newname" maxlength="120" placeholder="' + T('fp_new_ph') + '"><button type="button" class="primary" data-create>' + T('fp_create') + '</button><button type="button" data-cancel>✕</button></div>';
      if (st.error) html += '<div class="fp-warn" ' + pad + '>' + esc(st.error) + '</div>';
      if (st.warn) html += '<div class="fp-warn" ' + pad + '>⚠ ' + T('fp_similar') + ' ' + st.warn.matches.map(m => '<b>' + esc(leaf(m)) + '</b> <span class="small">(' + esc(parentOf(m) || '/') + ')</span>').join(', ') +
        '<div>' + st.warn.matches.map(m => '<button type="button" class="primary" data-use="' + esc(m) + '">' + T('fp_use', {name: esc(leaf(m))}) + '</button>').join('') +
        '<button type="button" data-force>' + T('fp_force', {name: esc(st.warn.name)}) + '</button></div></div>';
      return html;
    }
    function render() {
      const q = st.q.trim().toLowerCase();
      let visible = null;
      if (q) {visible = new Set(); folders().forEach(p => {if (p.toLowerCase().includes(q)) for (let a = p; a; a = parentOf(a)) visible.add(a)})}
      let html = '';
      const walk = (parent, depth) => children(parent).forEach(p => {
        if (visible && !visible.has(p)) return;
        const kids = children(p).length, open = st.open.has(p) || (visible && kids), isNew = st.extra.includes(p);
        html += '<div class="fp-node' + (p === st.sel ? ' sel' : '') + (isNew ? ' new' : '') + '" data-p="' + esc(p) + '" style="padding-left:' + (8 + depth * 22) + 'px">' +
          '<span class="fp-tw" data-tw="' + esc(p) + '">' + (kids ? (open ? '▼' : '▶') : '') + '</span>📁 ' + esc(leaf(p)) +
          (isNew ? ' <span class="fp-badge">' + T('fp_will_create') + '</span>' : '') + (counts[p] ? '<span class="fp-cnt">' + counts[p] + '</span>' : '') + '</div>';
        if (p === st.sel) html += addRow(p, depth + 1);
        if (open) walk(p, depth + 1);
      });
      walk('', 0);
      html += addRow('', 0);
      tree.innerHTML = html || '<div class="empty-note">' + T('no_data') + '</div>';
      const parts = st.sel ? st.sel.split('/') : [];
      side.innerHTML = '<h4>' + T('fp_selected') + '</h4>' + (st.sel
        ? '<div class="fp-crumbs">' + parts.map((x, i) => '<span class="' + (st.extra.includes(parts.slice(0, i + 1).join('/')) ? 'n' : '') + '">' + esc(x) + '</span>').join('›') + '</div><div class="fp-unc">' + esc(folderUnc(st.sel)) + '</div>' +
          (st.extra.some(p => st.sel === p || st.sel.startsWith(p + '/')) ? '<div class="note">' + T('fp_new_note') + '</div>' : '')
        : '<div class="empty-note">' + T('fp_choose') + '</div>') + '<div class="small fp-help">' + T('fp_help') + '</div>';
      tree.querySelectorAll('[data-tw]').forEach(el => el.onclick = e => {e.stopPropagation(); const p = el.dataset.tw; st.open.has(p) ? st.open.delete(p) : st.open.add(p); render()});
      tree.querySelectorAll('[data-p]').forEach(el => el.onclick = () => {st.sel = el.dataset.p; st.open.add(st.sel); st.adding = null; st.warn = null; render(); opts.onChange && opts.onChange(st.sel)});
      tree.querySelectorAll('[data-add]').forEach(el => el.onclick = () => {st.adding = el.dataset.add; st.warn = null; st.error = ''; render()});
      const inp = tree.querySelector('.fp-newname');
      if (inp) {
        inp.value = st.warn ? st.warn.name : ''; inp.focus();
        inp.onkeydown = e => {if (e.key === 'Enter') {e.preventDefault(); create(false)} if (e.key === 'Escape') {e.preventDefault(); st.adding = null; render()}};
        tree.querySelector('[data-create]').onclick = () => create(false);
        tree.querySelector('[data-cancel]').onclick = () => {st.adding = null; st.warn = null; render()};
        tree.querySelectorAll('[data-use]').forEach(b => b.onclick = () => select(b.dataset.use));
        const force = tree.querySelector('[data-force]'); if (force) force.onclick = () => create(true);
      }
    }
    function select(p) {st.sel = p; expandTo(p); st.open.add(p); st.adding = null; st.warn = null; render(); opts.onChange && opts.onChange(p)}
    function create(force) {
      const inp = tree.querySelector('.fp-newname'), name = (inp.value || '').trim().replace(/\s+/g, ' ');
      const parent = st.adding;
      st.error = '';
      if (!name || /[<>:"/\\|?*]/.test(name) || /^\.+$/.test(name)) {st.error = T('fp_bad_name'); st.warn = null; render(); return}
      const path = parent ? parent + '/' + name : name;
      const exact = children(parent).find(p => leaf(p).toLowerCase() === name.toLowerCase());
      if (exact) return select(exact);
      if (!force) {
        const depth = path.split('/').length;
        const same = folders().filter(p => p.split('/').length === depth && p !== path);
        const close = n => squash(n) === squash(name) || (name.length >= 4 && lev(n.toLowerCase(), name.toLowerCase()) <= 2);
        const matches = same.filter(p => close(leaf(p))).sort((a, b) => (parentOf(a) === parent ? -1 : 0) - (parentOf(b) === parent ? -1 : 0)).slice(0, 3);
        if (matches.length) {st.warn = {name, matches}; render(); return}
      }
      st.extra.push(path); select(path);
    }
    render();
    return {get value() {return st.sel}};
  }

  // ---- Перенос документов: сотрудник предлагает, администратор переносит ----
  async function loadFolders() {
    if (window.CATALOG_FOLDERS) return window.CATALOG_FOLDERS;
    try {return (await (await api('/api/folders')).json()).folders} catch {return []}
  }
  async function moveDialog(items, opts = {}) {
    const admin = !!opts.admin, existing = opts.existing || null;
    const folders = await loadFolders();
    const current = items.length ? relFolder(items[0]) : '';
    const paths = items.map(f => f.path);
    modal('<div class="modal-head"><h3>⇄ ' + T(admin ? 'mv_title_admin' : existing ? 'mv_title_edit' : 'mv_title_user') + '</h3><button data-close class="x">✕</button></div>' +
      (existing && existing.status === 'changes' ? '<div class="note">' + T('changes_requested_note') + '</div>' : '') +
      '<div class="small">' + T(admin ? 'mv_intro_admin' : 'mv_intro_user') + '</div>' +
      '<h4>' + T('mv_files', {n: items.length}) + '</h4><div class="filelist">' + items.map(f => '<div class="fileitem">📄 <b>' + esc(f.doc_name || f.name) + '</b> <span class="small">' + esc(String(f.relative || '').replace(/\//g, '\\')) + '</span></div>').join('') + '</div>' +
      '<h4>' + T('mv_target') + ' *</h4><div id="mvPicker"></div>' +
      '<label class="mv-reason">' + T('mv_reason') + (admin ? '' : ' *') + '<textarea id="mvReason" rows="2" maxlength="2000" placeholder="' + T('mv_reason_ph') + '">' + esc(existing ? existing.description : '') + '</textarea></label>' +
      '<div class="note warnnote">⚠ ' + T('mv_links_warning') + '</div>' +
      (admin ? '<label class="check"><input type="checkbox" id="mvNotify" checked> <span id="mvImpact">' + T('mv_notify_loading') + '</span></label>' : '') +
      '<div class="err" id="mvErr"></div><div class="actions"><button data-close>' + T('cancel') + '</button><button class="primary" id="mvGo">' + T(admin ? 'mv_go_admin' : existing ? 'resend' : 'send_for_review') + '</button></div>', async (back, close) => {
      const picker = folderPicker(back.querySelector('#mvPicker'), {folders, files: window.CATALOG_FILES || [], value: existing ? existing.target : current});
      const err = back.querySelector('#mvErr');
      let impact = 0;
      if (admin) {
        const d = await (await post('/api/admin/move-impact', {paths})).json().catch(() => ({count: 0}));
        impact = d.count || 0;
        back.querySelector('#mvImpact').textContent = impact ? T('mv_notify_n', {n: impact, days: d.days || 30}) + (d.people && d.people.length ? ': ' + d.people.join(', ') : '') : T('mv_notify_none');
      }
      back.querySelector('#mvGo').onclick = async () => {
        const target = picker.value, reason = back.querySelector('#mvReason').value.trim();
        err.textContent = '';
        if (!target) {err.textContent = T('sub_err_target'); return}
        if (items.length && items.every(f => relFolder(f) === target)) {err.textContent = T('mv_err_same_folder'); return}
        if (!admin && !reason) {err.textContent = T('mv_err_reason'); return}
        if (admin) {
          if (!confirm(T('mv_confirm', {n: items.length, target: target.replace(/\//g, ' › '), people: impact}))) return;
          const r = await post('/api/admin/move', {paths, target, reason, notify: back.querySelector('#mvNotify').checked});
          const d = await r.json().catch(() => ({}));
          if (!r.ok && !d.moved) {err.textContent = d.error || ('HTTP ' + r.status); return}
          const failed = Object.entries(d.failed || {});
          if (failed.length) {err.textContent = T('mv_partial', {ok: d.moved.length, n: items.length}) + '\n' + failed.map(([k, v]) => v).join('\n'); if (!d.moved.length) return}
          else close();
          toast(T('mv_done', {n: d.moved.length, target: esc(target.replace(/\//g, ' › '))}) + '<br>' + T('mv_done_reminder'), 8000);
          opts.onDone && opts.onDone(d);
          return;
        }
        let r;
        if (existing) {const fd = new FormData(); fd.set('target', target); fd.set('description', reason); fd.set('title', existing.title); r = await api('/api/my/submissions/' + existing.id, {method: 'POST', body: fd})}
        else r = await post('/api/my/moves', {paths, target, reason});
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {err.textContent = d.error || ('HTTP ' + r.status); return}
        close(); toast(T(existing ? 'sub_resent' : 'mv_sent', {id: d.id}), 6000);
        opts.onDone && opts.onDone(d);
      };
    }, null, 'xwide');
  }

  // Окно «Документ перенесён»: по старой ссылке, из избранного, в свойствах.
  function movedNotice(moves, newPathOf) {
    if (!moves.length) return;
    modal('<h3>⇄ ' + T(moves.length > 1 ? 'moved_title_many' : 'moved_title') + '</h3>' + moves.map(m => '<div class="moved-item"><b>' + esc(m.doc_name || '') + '</b>' +
      '<div class="small">' + T('moved_when', {ts: esc(m.ts), who: esc(m.who || 'admin')}) + (m.reason ? ' · ' + T('reason') + ': ' + esc(m.reason) : '') + '</div>' +
      '<div class="mv-path old">✕ ' + esc(unc({relative: (m.old_rel || '').replace(/\\/g, '/'), unc: m.old_rel})) + '</div>' +
      '<div class="mv-path new">✓ ' + esc(unc({relative: (m.new_rel || '').replace(/\\/g, '/'), unc: m.new_rel})) + '</div>' +
      '<button type="button" data-copy="' + esc(unc({relative: (m.new_rel || '').replace(/\\/g, '/'), unc: m.new_rel})) + '">📋 ' + T('copy_new_path') + '</button></div>').join('') +
      '<div class="note warnnote">' + T('moved_update_links') + '</div><div class="actions"><button class="primary" data-close>' + T('close') + '</button></div>', back => {
      back.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {try {await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✓ ' + T('copied')} catch {prompt(T('copy_manually'), b.dataset.copy)}});
    }, null, 'wide');
  }

  // ---- Присутствие: имя, данные ПК, «пульс» серверу ----
  let deviceInfo = null;
  async function collectDevice() {
    if (deviceInfo) return deviceInfo;
    const ua = navigator.userAgent;
    let os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    let browser = '';
    try {  // Chrome и Edge: Client Hints различают Windows 10 и 11
      const uad = navigator.userAgentData;
      if (uad) {
        const v = await uad.getHighEntropyValues(['platformVersion', 'fullVersionList']);
        if (uad.platform === 'Windows' && v.platformVersion) os = 'Windows ' + (parseInt(v.platformVersion) >= 13 ? '11' : '10');
        const brand = (v.fullVersionList || []).find(b => !/Not.A.Brand|Chromium/i.test(b.brand));
        if (brand) browser = brand.brand.replace('Google ', '').replace('Microsoft ', '') + ' ' + brand.version.split('.')[0];
      }
    } catch {}
    deviceInfo = {os, browser, screen: screen.width + '×' + screen.height, lang: navigator.language || '', tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '')};
    return deviceInfo;
  }
  const shownImportant = new Set(JSON.parse(store.get('doc-seen-important', '[]')));
  async function hello() {
    const who = document.getElementById('who');
    try {
      const d = await (await post('/api/hello', {user: state.user, doc: state.doc, page: state.page, ...(await collectDevice())})).json();
      if (who) {
        who.innerHTML = '<span class="dot on"></span><span>' + T('connected_as') + ' <b>' + esc(d.user) + '</b> <small>· ' + esc(d.host) + '</small></span>';
        who.title = T('who_details', {host: d.host, ip: d.ip, n: d.active});
      }
      const online = document.getElementById('online'); if (online) online.textContent = d.active;
      const badge = document.getElementById('inboxCount');
      if (badge) {badge.hidden = !d.unread; badge.textContent = d.unread}
      const fresh = (d.important || []).filter(m => !shownImportant.has(m.id));
      if (fresh.length && !document.querySelector('.modal-back')) {
        fresh.forEach(m => shownImportant.add(m.id)); store.set('doc-seen-important', JSON.stringify([...shownImportant].slice(-200)));
        modal('<h3>📨 ' + T('important_from_admin') + '</h3>' + fresh.map(m => '<div class="bubble admin">' + esc(m.text) + '</div>').join('') +
          '<div class="actions"><button data-close>' + T('close') + '</button><button class="primary" id="openInbox">' + T('open_inbox') + '</button></div>',
          (back, close) => back.querySelector('#openInbox').onclick = () => {close(); inbox()});
      }
    } catch {
      if (who) who.innerHTML = '<span class="dot"></span><span>' + T('no_connection') + '</span>';
    }
  }
  function askName(force, onDone) {
    if (state.user && !force) return onDone && onDone();
    modal('<h3>' + T('name_title') + '</h3><div>' + T('name_text') + '</div>' +
      '<input id="nameInput" maxlength="80" placeholder="' + T('name_ph') + '" value="' + esc(state.user) + '">' +
      '<div class="actions"><button data-close>' + T('later') + '</button><button class="primary" id="nameSave">' + T('save') + '</button></div>', (back, close) => {
      const inp = back.querySelector('#nameInput'); inp.focus(); inp.select();
      const save = () => {const v = inp.value.trim(); if (!v) return inp.focus(); state.user = v; store.set('doc-user', v); close()};
      back.querySelector('#nameSave').onclick = save; inp.onkeydown = e => {if (e.key === 'Enter') save()};
    }, onDone || hello);
  }
  function startPresence() {
    const who = document.getElementById('who'); if (who) who.onclick = () => askName(true);
    const ib = document.getElementById('inboxBtn'); if (ib) ib.onclick = () => inbox();
    // Первый сигнал отправляем после ввода имени, чтобы подключение попало в журнал уже с именем.
    askName(false, () => {hello(); setInterval(hello, 20000)});
    document.addEventListener('visibilitychange', () => {if (!document.hidden && state.user) hello()});
    window.addEventListener('pagehide', () => navigator.sendBeacon && navigator.sendBeacon('/api/bye', '{}'));
  }
  function setCurrentDoc(name) {state.doc = name || ''; if (state.user) hello()}

  // ---- Сообщения и мои заявки ----
  async function inbox(tab = 'messages') {
    const [m, s] = await Promise.all([api('/api/my/messages').then(r => r.json()), api('/api/my/submissions').then(r => r.json())]);
    const badge = document.getElementById('inboxCount'); if (badge) badge.hidden = true;
    const subsById = Object.fromEntries(s.items.map(x => [x.id, x]));
    const msgHtml = m.items.length ? m.items.map(x => '<div class="bubble ' + (x.sender === 'admin' ? 'admin' : 'me') + (x.important ? ' important' : '') + '"><div class="bmeta">' +
      (x.sender === 'admin' ? '🛡 ' + T('administrator') : '👤 ' + esc(x.user)) + ' · ' + esc(x.ts) + (x.submission_id ? ' · <span class="tag">#' + x.submission_id + ' ' + esc(x.submission_title) + '</span>' : '') + '</div>' + esc(x.text) + '</div>').join('')
      : '<div class="empty-note">' + T('no_messages') + '</div>';
    const subHtml = s.items.length ? s.items.map(x => '<div class="subcard"><div class="subhead"><b>#' + x.id + ' ' + esc(x.title) + '</b> ' + statusBadge(x.status) + '</div>' +
      '<div class="small">' + (x.kind === 'move' ? '<span class="kind-move">⇄ ' + T('kind_move') + '</span> ' + x.move_paths.length + ' ' + T('files_n') : esc(x.created_at) + ' · ' + x.files.length + ' ' + T('files_n')) + ' · → ' + esc((x.target || [x.documentation, x.rfq, x.system, x.unit].filter(Boolean).join('/')).replace(/\//g, ' › ')) + '</div>' +
      '<div class="desc">' + esc(x.description) + '</div>' +
      (['changes', 'pending', 'resubmitted'].includes(x.status) ? '<div class="actions"><button data-edit="' + x.id + '"' + (x.status === 'changes' ? ' class="primary"' : '') + '>✎ ' + T(x.status === 'changes' ? 'fix_and_resend' : 'edit') + '</button></div>' : '') + '</div>').join('')
      : '<div class="empty-note">' + T('no_submissions') + '</div>';
    modal('<div class="modal-head"><h3>📨 ' + T('inbox_title') + '</h3><button data-close class="x">✕</button></div>' +
      '<div class="tabs"><button data-tab="messages" class="' + (tab === 'messages' ? 'active' : '') + '">' + T('messages') + ' (' + m.items.length + ')</button><button data-tab="subs" class="' + (tab === 'subs' ? 'active' : '') + '">' + T('my_submissions') + ' (' + s.items.length + ')</button></div>' +
      '<div data-pane="messages"' + (tab === 'messages' ? '' : ' hidden') + '><div class="thread" id="thread">' + msgHtml + '</div>' +
      '<div class="reply"><select id="replySub"><option value="">' + T('msg_general') + '</option>' + s.items.map(x => '<option value="' + x.id + '">#' + x.id + ' ' + esc(x.title) + '</option>').join('') + '</select>' +
      '<textarea id="replyText" rows="3" placeholder="' + T('msg_to_admin_ph') + '"></textarea><div class="actions"><button class="primary" id="replySend">' + T('send') + '</button></div></div></div>' +
      '<div data-pane="subs"' + (tab === 'subs' ? '' : ' hidden') + '>' + subHtml + '</div>', (back, close) => {
      const th = back.querySelector('#thread'); th.scrollTop = th.scrollHeight;
      back.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
        back.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
        back.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
      });
      back.querySelector('#replySend').onclick = async () => {
        const text = back.querySelector('#replyText').value.trim(); if (!text) return;
        const r = await post('/api/my/messages', {text, submission_id: back.querySelector('#replySub').value || null});
        if (r.ok) {close(); toast(T('msg_sent')); inbox('messages')} else alert((await r.json()).error);
      };
      back.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        close(); const x = subsById[b.dataset.edit];
        if (x.kind === 'move') moveDialog(x.move_paths.map(p => (window.CATALOG_FILES || []).find(f => f.path === p) || {path: p, name: p.split(/[\\/]/).pop(), relative: ''}), {existing: x});
        else submitForm(x);
      });
    }, null, 'wide');
  }

  // ---- Форма заявки на новый документ (и исправление возвращённой) ----
  async function submitForm(existing, files) {
    files = files || window.CATALOG_FILES || [];
    const folders = await loadFolders();
    const U = window.UPLOAD || {max: 500, allowed: []};
    const allowed = new Set(U.allowed.map(e => '.' + e));
    const v = k => esc(existing ? existing[k] || '' : '');
    let picked = [];
    const removed = new Set();
    modal('<div class="modal-head"><h3>' + (existing ? '✎ ' + T('edit_submission') + ' #' + existing.id : '➕ ' + T('submit_doc')) + '</h3><button data-close class="x">✕</button></div>' +
      (existing && existing.status === 'changes' ? '<div class="note">' + T('changes_requested_note') + '</div>' : '<div class="small">' + T('submit_intro') + '</div>') +
      '<form id="subForm" class="form-grid">' +
      '<label class="full">' + T('fld_title') + ' *<input name="title" required maxlength="200" value="' + v('title') + '"></label>' +
      '<label class="full">' + T('fld_description') + ' *<textarea name="description" required rows="4" maxlength="4000">' + v('description') + '</textarea></label>' +
      '<label>' + T('fld_doc_type') + '<input name="doc_type" maxlength="120" list="dlType" value="' + v('doc_type') + '" placeholder="' + T('fld_doc_type_ph') + '"></label>' +
      '<label>' + T('fld_revision') + '<input name="revision" maxlength="40" value="' + v('revision') + '" placeholder="A, B, 01…"></label>' +
      '<div class="full"><div class="fp-label">' + T('fp_where') + ' *</div><div id="subPicker"></div></div>' +
      '<label class="full">' + T('fld_comment') + '<textarea name="comment" rows="2" maxlength="2000">' + v('comment') + '</textarea></label>' +
      '<div class="full"><div class="drop" id="drop">📎 ' + T('drop_files', {mb: U.max}) + '<input type="file" id="fileInput" multiple></div><div id="fileList" class="filelist"></div></div>' +
      '<datalist id="dlType">' + ['Datasheet', 'Drawing', 'Manual', 'Procedure', 'Report', 'Specification', 'Certificate'].map(x => '<option value="' + x + '">').join('') + '</datalist>' +
      '</form><div class="progress" id="progress" hidden><div></div></div><div class="err" id="subErr"></div>' +
      '<div class="actions"><button data-close>' + T('cancel') + '</button><button class="primary" id="subSend">' + T(existing ? 'resend' : 'send_for_review') + '</button></div>', (back, close) => {
      const list = back.querySelector('#fileList'), input = back.querySelector('#fileInput'), drop = back.querySelector('#drop'), err = back.querySelector('#subErr');
      const picker = folderPicker(back.querySelector('#subPicker'), {folders: folders, files, value: existing ? (existing.target || [existing.documentation, existing.rfq, existing.system, existing.unit].filter(Boolean).join('/')) : ''});
      const total = () => picked.reduce((s, f) => s + f.size, 0) + (existing ? existing.files.filter(f => !removed.has(f.id)).reduce((s, f) => s + f.size, 0) : 0);
      function render() {
        const old = existing ? existing.files.map(f => '<div class="fileitem' + (removed.has(f.id) ? ' removed' : '') + '">📄 ' + esc(f.orig_name) + ' <span class="small">' + fmtSize(f.size) + '</span><button type="button" data-old="' + f.id + '">' + (removed.has(f.id) ? T('restore') : '✕') + '</button></div>').join('') : '';
        list.innerHTML = old + picked.map((f, i) => '<div class="fileitem new">➕ ' + esc(f.name) + ' <span class="small">' + fmtSize(f.size) + '</span><button type="button" data-new="' + i + '">✕</button></div>').join('') +
          '<div class="small">' + T('total_size', {size: fmtSize(total()), mb: U.max}) + '</div>';
        list.querySelectorAll('[data-new]').forEach(b => b.onclick = () => {picked.splice(+b.dataset.new, 1); render()});
        list.querySelectorAll('[data-old]').forEach(b => b.onclick = () => {const id = +b.dataset.old; removed.has(id) ? removed.delete(id) : removed.add(id); render()});
      }
      function add(fl) {
        err.textContent = '';
        for (const f of fl) {
          const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
          if (!allowed.has(ext)) {err.textContent = T('sub_err_ext', {name: f.name, ext: ext || '—'}); continue}
          picked.push(f);
        }
        render();
      }
      input.onchange = () => {add(input.files); input.value = ''};
      drop.onclick = e => {if (e.target !== input) input.click()};
      ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => {e.preventDefault(); drop.classList.add('over')}));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {e.preventDefault(); drop.classList.remove('over')}));
      drop.addEventListener('drop', e => add(e.dataTransfer.files));
      render();
      back.querySelector('#subSend').onclick = () => {
        const form = back.querySelector('#subForm');
        if (!form.reportValidity()) return;
        if (!picker.value) {err.textContent = T('sub_err_target'); return}
        const keep = existing ? existing.files.filter(f => !removed.has(f.id)).length : 0;
        if (!picked.length && !keep) {err.textContent = T('sub_err_files'); return}
        if (total() > U.max * 1024 * 1024) {err.textContent = T('err_too_large', {mb: U.max}); return}
        const fd = new FormData(form);
        fd.set('target', picker.value);
        picked.forEach(f => fd.append('files', f));
        removed.forEach(id => fd.append('remove', id));
        const xhr = new XMLHttpRequest(), bar = back.querySelector('#progress');
        xhr.open('POST', existing ? '/api/my/submissions/' + existing.id : '/api/my/submissions');
        xhr.setRequestHeader('X-Portal', '1');
        bar.hidden = false; back.querySelector('#subSend').disabled = true;
        xhr.upload.onprogress = e => {if (e.lengthComputable) bar.firstChild.style.width = (e.loaded / e.total * 100) + '%'};
        xhr.onload = () => {
          let d = {}; try {d = JSON.parse(xhr.responseText)} catch {}
          if (xhr.status === 200) {close(); toast(T(existing ? 'sub_resent' : 'sub_sent', {id: d.id}), 6000)}
          else {err.textContent = d.error || ('HTTP ' + xhr.status); bar.hidden = true; back.querySelector('#subSend').disabled = false}
        };
        xhr.onerror = () => {err.textContent = T('no_connection'); bar.hidden = true; back.querySelector('#subSend').disabled = false};
        xhr.send(fd);
      };
    }, null, 'wide');
  }

  // ---- Открытие ----
  const OFFICE = {word: 'ms-word', excel: 'ms-excel', powerpoint: 'ms-powerpoint', visio: 'ms-visio'};
  const helperInstalled = () => store.get('doc-helper', '') === '1';
  const fileUrl = unc => 'file:' + unc.replace(/\\/g, '/').split('/').map((s, i) => i < 2 ? s : encodeURIComponent(s)).join('/');
  function launch(url) {const a = document.createElement('a'); a.href = url; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove()}
  function openView(f) {window.open('/view?path=' + encodeURIComponent(f.path), '_blank')}

  async function copyPath(f, btn) {
    let ok = true;
    const path = unc(f);
    try {await navigator.clipboard.writeText(path)} catch {ok = false}
    if (!ok) {  // http:// без localhost: Clipboard API может быть недоступен
      const ta = document.createElement('textarea'); ta.value = path; document.body.appendChild(ta); ta.select();
      try {ok = document.execCommand('copy')} catch {} ta.remove();
    }
    if (ok) {toast(T('path_copied', {path: esc(path)})); if (btn) {const t = btn.innerHTML; btn.innerHTML = '✓ ' + T('copied'); setTimeout(() => btn.innerHTML = t, 1800)}}
    else prompt(T('copy_manually'), path);
    log('copy_path', f);
  }
  function openApp(f) {
    if (helperInstalled()) {launch('docopen:' + encodeURIComponent(unc(f))); log('open_app', f, 'helper'); return}
    const scheme = OFFICE[f.kind];
    if (scheme) {
      launch(scheme + ':ofv|u|' + fileUrl(unc(f))); log('open_app', f, scheme);
      toast(T('opening_in', {app: {word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', visio: 'Visio'}[f.kind]}) + ' <a href="#" id="helperLink">' + T('install_helper_link') + '</a>', 7000);
      const l = document.getElementById('helperLink'); if (l) l.onclick = e => {e.preventDefault(); helperDialog(f)};
      return;
    }
    helperDialog(f);
  }
  function helperDialog(f) {
    modal('<h3>' + T('helper_title') + '</h3><p>' + T('helper_p1') + '</p><p>' + T('helper_p2') + '</p><p>' + T('helper_p3') + '</p>' +
      '<div class="actions"><button data-close>' + T('close') + '</button><button id="hCopy">' + T('copy_path') + '</button><button id="hInstall">' + T('install_helper') + '</button><button class="primary" id="hDone">' + T('helper_installed') + '</button></div>', (back, close) => {
      back.querySelector('#hCopy').onclick = () => {copyPath(f); close()};
      back.querySelector('#hInstall').onclick = () => {if (confirm(T('helper_confirm'))) location.href = '/helper/install.cmd'};
      back.querySelector('#hDone').onclick = () => {store.set('doc-helper', '1'); close(); openApp(f)};
    });
  }
  function download(f, url) {
    if (!confirm(T('confirm_download', {name: f.name || f.orig_name, size: f.size != null ? fmtSize(f.size) : ''}))) return;
    location.href = url || '/api/raw?download=1&path=' + encodeURIComponent(f.path);
  }
  // Кнопки действий: «Открыть» всегда первая и самая заметная.
  function actionsHtml(f, opts = {}) {
    return (opts.noOpen ? '' : '<button class="open-btn" data-act="open" title="' + T('open_hint') + '">↗ ' + T('open') + '</button>') +
      '<button data-act="app" title="' + T('in_app_hint') + '">🖥 ' + T('in_app') + '</button>' +
      '<button data-act="copy" title="' + T('copy_path_hint') + '">📋 ' + T('copy_path') + '</button>' +
      '<button data-act="download" title="' + T('download_hint') + '">⤓ ' + T('download') + '…</button>' + (opts.extra || '');
  }
  function bindActions(root, f) {
    root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ({open: () => openView(f), app: () => openApp(f), copy: () => copyPath(f, b), download: () => download(f)}[b.dataset.act] || (() => {}))());
  }

  // ---- Предпросмотр ----
  let previewToken = 0;
  async function preview(box, f, opts = {}) {
    const token = ++previewToken;
    box.className = 'preview'; box.innerHTML = '<div class="msg"><span class="spinner"></span>' + T('loading_preview') + '</div>';
    let url = opts.url;
    if (!url) {const params = new URLSearchParams({path: f.path}); if (opts.nolog) params.set('log', '0'); url = '/api/preview?' + params}
    let d;
    try {d = await (await api(url)).json()} catch (e) {d = {kind: 'error', message: e.message}}
    if (token !== previewToken) return;
    switch (d.kind) {
      case 'pdf': box.className = 'preview frame'; box.innerHTML = '<iframe title="PDF" src="' + d.url + '#toolbar=1&navpanes=0&view=FitH"></iframe>'; break;
      case 'image': box.className = 'preview frame'; box.innerHTML = '<img alt="' + esc(d.name) + '" src="' + d.url + '">'; break;
      case 'video': box.className = 'preview media'; box.innerHTML = '<video controls controlsList="nodownload" preload="metadata" src="' + d.url + '"></video>'; break;
      case 'audio': box.className = 'preview media'; box.innerHTML = '<audio controls controlsList="nodownload" src="' + d.url + '"></audio>'; break;
      case 'frame': box.className = 'preview frame'; box.innerHTML = '<iframe sandbox title="HTML" src="' + d.url + '"></iframe>'; break;
      case 'html': {
        box.className = 'preview frame'; box.innerHTML = (d.note ? '<div class="note">' + esc(d.note) + '</div>' : '') + '<iframe sandbox title="Document"></iframe>';
        const fr = box.querySelector('iframe'); if (d.note) fr.style.height = 'calc(100% - 34px)';
        fr.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font:13px Segoe UI,Arial,sans-serif;color:#172536;margin:14px;line-height:1.5}table{border-collapse:collapse;margin:8px 0 18px;font-size:12px}td,th{border:1px solid #d5dde6;padding:3px 7px;vertical-align:top}h3{margin:16px 0 6px}.slide{border:1px solid #d5dde6;border-radius:8px;padding:10px 14px;margin-bottom:12px}.n{font-size:11px;color:#64748b}pre{white-space:pre-wrap}</style>' + d.html;
        break;
      }
      case 'text': box.textContent = d.content + (d.truncated ? '\n\n[' + T('first_mb') + ']' : ''); break;
      case 'pending':
        box.innerHTML = '<div class="msg"><span class="spinner"></span>' + esc(d.message) + '</div>';
        setTimeout(() => {if (token === previewToken) preview(box, f, {...opts, nolog: true})}, 1500);
        break;
      default:
        box.innerHTML = '<div class="msg">' + esc(d.message || T('preview_unavailable')) + (opts.noActions ? '' : '<div class="actions">' + actionsHtml(f, {noOpen: true}) + '</div>') + '</div>';
        if (!opts.noActions) bindActions(box, f);
    }
  }

  // Переключатель языка: открывается по клику, закрывается по клику вне меню.
  const ls = document.getElementById('langSwitch');
  if (ls) {
    ls.querySelector('.lang-btn').onclick = e => {e.stopPropagation(); ls.classList.toggle('open')};
    document.addEventListener('click', () => ls.classList.remove('open'));
  }

  return {store, T, esc, fmtSize, api, post, log, toast, modal, srcBadge, statusBadge, unc, folderPicker, moveDialog, movedNotice, relFolder, startPresence, setCurrentDoc, askName, inbox, submitForm,
          openView, openApp, copyPath, download, actionsHtml, bindActions, preview};
})();
