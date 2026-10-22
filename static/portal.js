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
      '<div class="small">' + esc(x.created_at) + ' · ' + x.files.length + ' ' + T('files_n') + ' · ' + esc([x.documentation, x.rfq, x.system, x.unit].filter(Boolean).join(' / ')) + '</div>' +
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
      back.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {close(); submitForm(subsById[b.dataset.edit])});
    }, null, 'wide');
  }

  // ---- Форма заявки на новый документ (и исправление возвращённой) ----
  function submitForm(existing, files) {
    files = files || window.CATALOG_FILES || [];
    const U = window.UPLOAD || {max: 500, allowed: []};
    const allowed = new Set(U.allowed.map(e => '.' + e));
    const v = k => esc(existing ? existing[k] || '' : '');
    const dl = key => [...new Set(files.map(f => f[key]).filter(Boolean))].sort().map(x => '<option value="' + esc(x) + '">').join('');
    let picked = [];
    const removed = new Set();
    modal('<div class="modal-head"><h3>' + (existing ? '✎ ' + T('edit_submission') + ' #' + existing.id : '➕ ' + T('submit_doc')) + '</h3><button data-close class="x">✕</button></div>' +
      (existing && existing.status === 'changes' ? '<div class="note">' + T('changes_requested_note') + '</div>' : '<div class="small">' + T('submit_intro') + '</div>') +
      '<form id="subForm" class="form-grid">' +
      '<label class="full">' + T('fld_title') + ' *<input name="title" required maxlength="200" value="' + v('title') + '"></label>' +
      '<label class="full">' + T('fld_description') + ' *<textarea name="description" required rows="4" maxlength="4000">' + v('description') + '</textarea></label>' +
      '<label>' + T('fld_doc_type') + '<input name="doc_type" maxlength="120" list="dlType" value="' + v('doc_type') + '" placeholder="' + T('fld_doc_type_ph') + '"></label>' +
      '<label>' + T('fld_revision') + '<input name="revision" maxlength="40" value="' + v('revision') + '" placeholder="A, B, 01…"></label>' +
      '<label>' + T('f_documentation') + '<input name="documentation" list="dlDoc" maxlength="120" value="' + v('documentation') + '"></label>' +
      '<label>RFQ<input name="rfq" list="dlRfq" maxlength="120" value="' + v('rfq') + '"></label>' +
      '<label>' + T('f_system') + '<input name="system" list="dlSys" maxlength="120" value="' + v('system') + '"></label>' +
      '<label>UNIT<input name="unit" list="dlUnit" maxlength="120" value="' + v('unit') + '"></label>' +
      '<label class="full">' + T('fld_comment') + '<textarea name="comment" rows="2" maxlength="2000">' + v('comment') + '</textarea></label>' +
      '<div class="full"><div class="drop" id="drop">📎 ' + T('drop_files', {mb: U.max}) + '<input type="file" id="fileInput" multiple></div><div id="fileList" class="filelist"></div></div>' +
      '<datalist id="dlDoc">' + dl('documentation') + '</datalist><datalist id="dlRfq">' + dl('rfq') + '</datalist><datalist id="dlSys">' + dl('system') + '</datalist><datalist id="dlUnit">' + dl('unit') + '</datalist>' +
      '<datalist id="dlType">' + ['Datasheet', 'Drawing', 'Manual', 'Procedure', 'Report', 'Specification', 'Certificate'].map(x => '<option value="' + x + '">').join('') + '</datalist>' +
      '</form><div class="progress" id="progress" hidden><div></div></div><div class="err" id="subErr"></div>' +
      '<div class="actions"><button data-close>' + T('cancel') + '</button><button class="primary" id="subSend">' + T(existing ? 'resend' : 'send_for_review') + '</button></div>', (back, close) => {
      const list = back.querySelector('#fileList'), input = back.querySelector('#fileInput'), drop = back.querySelector('#drop'), err = back.querySelector('#subErr');
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
        const keep = existing ? existing.files.filter(f => !removed.has(f.id)).length : 0;
        if (!picked.length && !keep) {err.textContent = T('sub_err_files'); return}
        if (total() > U.max * 1024 * 1024) {err.textContent = T('err_too_large', {mb: U.max}); return}
        const fd = new FormData(form);
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
    try {await navigator.clipboard.writeText(f.unc)} catch {ok = false}
    if (!ok) {  // http:// без localhost: Clipboard API может быть недоступен
      const ta = document.createElement('textarea'); ta.value = f.unc; document.body.appendChild(ta); ta.select();
      try {ok = document.execCommand('copy')} catch {} ta.remove();
    }
    if (ok) {toast(T('path_copied', {path: esc(f.unc)})); if (btn) {const t = btn.innerHTML; btn.innerHTML = '✓ ' + T('copied'); setTimeout(() => btn.innerHTML = t, 1800)}}
    else prompt(T('copy_manually'), f.unc);
    log('copy_path', f);
  }
  function openApp(f) {
    if (helperInstalled()) {launch('docopen:' + encodeURIComponent(f.unc)); log('open_app', f, 'helper'); return}
    const scheme = OFFICE[f.kind];
    if (scheme) {
      launch(scheme + ':ofv|u|' + fileUrl(f.unc)); log('open_app', f, scheme);
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

  return {store, T, esc, fmtSize, api, post, log, toast, modal, srcBadge, statusBadge, startPresence, setCurrentDoc, askName, inbox, submitForm,
          openView, openApp, copyPath, download, actionsHtml, bindActions, preview};
})();
