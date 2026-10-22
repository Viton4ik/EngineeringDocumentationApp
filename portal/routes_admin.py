"""Админ-панель: вход по паролю, подключения, сотрудники, блокировки, заявки, сообщения, статистика."""
from __future__ import annotations
import io, os, csv, json, time, tempfile
from datetime import datetime, timedelta
from urllib.parse import quote
from flask import Blueprint, render_template, request, jsonify, send_file, abort, redirect, session
from .config import HOST, DOC_SHARE, SOFFICE, FFMPEG, DEFENDER, Image, UPLOAD_MAX_MB, ALLOWED_EXTS, EXEC_EXTS
from pathlib import Path
from .catalog import CACHE, TITLES, LOCK, root, find_record
from .clients import active_sessions, log_event, refresh_blocks, current_client, STATE_LOCK, SESSIONS
from .db import query, query_one, execute, now_str
from .preview import preview_payload
from . import auth, moves, submissions as subs
from .submissions import SubmissionError
from .routes_public import send_inline
from .i18n import t

bp = Blueprint("admin", __name__)

def common():
    return dict(host=HOST, root=str(root()), share=DOC_SHARE, is_admin=auth.is_admin(), is_server=auth.is_server_request(), can_approve=auth.can_approve())

def admin_client():
    c = current_client()
    return {**c, "user": "admin"}

# ---------- Вход ----------
@bp.route("/admin/login", methods=["GET", "POST"])
def login():
    if not auth.has_admin_password():
        return render_template("login.html", error=t("adm_no_password"), disabled=True, **common())
    error = None
    ip = request.remote_addr or "?"
    if request.method == "POST":
        if auth.is_locked(ip):
            error = t("adm_locked", minutes=auth.LOCK_MINUTES)
        elif request.form.get("username", "").strip().lower() == auth.ADMIN_USER and auth.check_admin_password(request.form.get("password", "")):
            auth.login_session()
            log_event("admin_login", client=admin_client())
            nxt = request.args.get("next", "/admin")
            return redirect(nxt if nxt.startswith("/admin") else "/admin")
        else:
            log_event("admin_login_fail", details=request.form.get("username", "")[:40])
            print(f"[!] неудачный вход admin с {ip}")
            error = t("adm_locked", minutes=auth.LOCK_MINUTES) if auth.is_locked(ip) else t("adm_bad_login")
    return render_template("login.html", error=error, disabled=False, **common())

@bp.get("/admin/logout")
def logout():
    if auth.is_admin(): log_event("admin_logout", client=admin_client())
    session.clear()
    return redirect("/")

@bp.get("/admin")
@auth.admin_required
def dashboard():
    return render_template("admin.html", unc_admin_share=not DOC_SHARE, soffice=SOFFICE, ffmpeg=FFMPEG, pillow=Image is not None,
                           defender=DEFENDER, upload_max=UPLOAD_MAX_MB, **common())

# ---------- Обзор: карточки и диаграммы ----------
def date_range():
    a = request.args
    start = a.get("from") or (datetime.now() - timedelta(days=29)).strftime("%Y-%m-%d")
    end = a.get("to") or datetime.now().strftime("%Y-%m-%d")
    return start + " 00:00:00", end + " 23:59:59"

@bp.get("/api/admin/overview")
@auth.admin_required
def overview():
    day_ago = (datetime.now() - timedelta(hours=24)).isoformat(sep=" ", timespec="seconds")
    today = datetime.now().strftime("%Y-%m-%d")
    count = lambda sql, args=(): query_one(sql, args)["n"]
    cards = {
        "pending": count("SELECT COUNT(*) n FROM submissions WHERE status='pending'"),
        "resubmitted": count("SELECT COUNT(*) n FROM submissions WHERE status='resubmitted'"),
        "messages": count("SELECT COUNT(*) n FROM messages WHERE sender='user' AND read_admin=0"),
        "security": count("SELECT COUNT(*) n FROM events WHERE action IN ('admin_login_fail','blocked_attempt') AND ts>=?", (day_ago,)),
        "approved_today": count("SELECT COUNT(*) n FROM submissions WHERE status='approved' AND decided_at>=?", (today,)),
        "active": len(active_sessions()),
        "devices": count("SELECT COUNT(*) n FROM devices"),
        "blocks": count("SELECT COUNT(*) n FROM blocks WHERE active=1"),
    }
    start, end = date_range()
    rng = (start, end)
    per_day = query("SELECT substr(ts,1,10) day, COUNT(*) n, COUNT(DISTINCT client_id) devices FROM events WHERE ts BETWEEN ? AND ? GROUP BY day ORDER BY day", rng)
    by_action = query("SELECT action, COUNT(*) n FROM events WHERE ts BETWEEN ? AND ? GROUP BY action ORDER BY n DESC", rng)
    heat = query("SELECT CAST(strftime('%w', ts) AS INTEGER) wd, CAST(substr(ts,12,2) AS INTEGER) hr, COUNT(*) n FROM events WHERE ts BETWEEN ? AND ? AND action<>'connect' GROUP BY wd, hr", rng)
    top_users = query("SELECT user, host, COUNT(*) n FROM events WHERE ts BETWEEN ? AND ? AND user NOT IN ('—','admin','') GROUP BY user, host ORDER BY n DESC LIMIT 10", rng)
    top_docs = query("SELECT MAX(doc_name) doc_name, path, COUNT(*) n, COUNT(DISTINCT host) machines FROM events WHERE ts BETWEEN ? AND ? AND action IN ('preview','open','open_app','download') AND path<>'' GROUP BY path ORDER BY n DESC LIMIT 10", rng)
    os_rows = query("SELECT COALESCE(NULLIF(os,''),'?') label, COUNT(*) n FROM devices WHERE last_seen BETWEEN ? AND ? GROUP BY label ORDER BY n DESC", rng)
    br_rows = query("SELECT COALESCE(NULLIF(browser,''),'?') label, COUNT(*) n FROM devices WHERE last_seen BETWEEN ? AND ? GROUP BY label ORDER BY n DESC LIMIT 8", rng)
    sub_status = query("SELECT status, COUNT(*) n FROM submissions GROUP BY status")
    base = str(root())
    for d in top_docs:
        if d["path"].startswith(base): d["path"] = d["path"][len(base):].lstrip("\\/")
    return jsonify({"cards": cards, "per_day": per_day, "by_action": by_action, "heat": heat, "top_users": top_users, "top_docs": top_docs,
                    "os": os_rows, "browsers": br_rows, "sub_status": sub_status, "range": [start[:10], end[:10]]})

# ---------- Подключения и сотрудники ----------
@bp.get("/api/admin/active")
@auth.admin_required
def admin_active():
    now = time.time()
    rows = [{"client_id": s["client_id"], "user": s["user"], "host": s["host"], "ip": s["ip"], "os": s.get("os", ""), "browser": s.get("browser", ""),
             "screen": s.get("screen", ""), "since": datetime.fromtimestamp(s.get("since", s["first_seen"])).strftime("%Y-%m-%d %H:%M:%S"),
             "idle": int(now - s["last_seen"]), "doc": s.get("doc", "")}
            for s in sorted(active_sessions(), key=lambda x: x["user"].casefold())]
    with LOCK: titles = {k: TITLES[k] for k in ("running", "done", "total", "found")}
    return jsonify({"active": rows, "count": len(rows), "machines": len({r["host"] for r in rows}), "titles": titles,
                    "files": len(CACHE["files"]), "scanned_at": CACHE["scanned_at"]})

@bp.get("/api/admin/devices")
@auth.admin_required
def devices():
    q = f"%{request.args.get('q', '')}%"
    rows = query("SELECT * FROM devices WHERE user LIKE ? OR host LIKE ? OR ip LIKE ? OR names LIKE ? ORDER BY last_seen DESC LIMIT 1000", (q, q, q, q))
    blocks = query("SELECT * FROM blocks WHERE active=1")
    online = {s["client_id"] for s in active_sessions()}
    by_host = {}
    for r in rows:
        r["names"] = json.loads(r["names"] or "[]")
        r["online"] = r["client_id"] in online
        r["blocked"] = any((b["client_id"] and b["client_id"] == r["client_id"]) or (b["ip"] and b["ip"] == r["ip"]) or
                           (b["host"] and r["host"] and b["host"].casefold() == (r["host"] or "").casefold()) for b in blocks)
        if r["host"] and r["host"] != r["ip"]: by_host.setdefault(r["host"], set()).update(r["names"])
    for r in rows:  # разные имена с одного ПК - повод присмотреться
        r["host_names"] = sorted(by_host.get(r["host"], set()))
    return jsonify({"items": rows})

# ---------- Блокировки ----------
@bp.get("/api/admin/blocks")
@auth.admin_required
def blocks():
    return jsonify({"items": query("SELECT * FROM blocks ORDER BY active DESC, id DESC LIMIT 500")})

@bp.post("/api/admin/blocks")
@auth.admin_required
def add_block():
    d = request.get_json(silent=True) or {}
    ip = (d.get("ip") or "").strip() if d.get("use_ip", True) else ""
    host = (d.get("host") or "").strip() if d.get("use_host", True) else ""
    cid = (d.get("client_id") or "").strip() if d.get("use_cid", True) else ""
    if host == ip: host = host if not ip else ""  # имя ПК, совпадающее с IP, ничего не добавляет
    if ip in ("127.0.0.1", "::1"): return jsonify({"error": t("blk_err_server")}), 400
    if not (ip or host or cid): return jsonify({"error": t("blk_err_empty")}), 400
    until = (d.get("until") or "").strip()
    until = until + " 23:59:59" if until else None
    bid = execute("INSERT INTO blocks(ip,host,client_id,user,reason,created_at,until,active) VALUES(?,?,?,?,?,?,?,1)",
                  (ip, host, cid, (d.get("user") or "")[:80], (d.get("reason") or "")[:300], now_str(), until))
    refresh_blocks()
    log_event("block", details=f"#{bid} {d.get('user', '')} {ip} {host} {d.get('reason', '')}", client=admin_client())
    print(f"[⛔] заблокирован {d.get('user', '')} ({host or '-'}, {ip or '-'})")
    return jsonify({"id": bid})

@bp.post("/api/admin/blocks/<int:bid>/remove")
@auth.admin_required
def remove_block(bid):
    execute("UPDATE blocks SET active=0, removed_at=? WHERE id=?", (now_str(), bid))
    refresh_blocks()
    log_event("unblock", details=f"#{bid}", client=admin_client())
    return jsonify({"ok": True})

# ---------- Журнал ----------
def event_filters():
    a = request.args
    where, args = [], []
    if a.get("from"): where.append("ts >= ?"); args.append(a["from"] + " 00:00:00")
    if a.get("to"): where.append("ts <= ?"); args.append(a["to"] + " 23:59:59")
    for key in ("host", "user", "ip"):
        if a.get(key): where.append(f"{key} LIKE ?"); args.append(f"%{a[key]}%")
    if a.get("action"): where.append("action = ?"); args.append(a["action"])
    if a.get("q"): where.append("(path LIKE ? OR doc_name LIKE ? OR details LIKE ?)"); args += [f"%{a['q']}%"] * 3
    return (" WHERE " + " AND ".join(where)) if where else "", args

@bp.get("/api/admin/events")
@auth.admin_required
def admin_events():
    where, args = event_filters()
    page, size = max(int(request.args.get("page", 1) or 1), 1), 200
    total = query_one(f"SELECT COUNT(*) n FROM events{where}", args)["n"]
    rows = query(f"SELECT ts,ip,host,user,action,path,doc_name,details FROM events{where} ORDER BY id DESC LIMIT ? OFFSET ?", args + [size, (page - 1) * size])
    base = str(root())
    for r in rows:
        if (r["path"] or "").startswith(base): r["path"] = r["path"][len(base):].lstrip("\\/")
    return jsonify({"rows": rows, "total": total, "page": page, "pages": max((total + size - 1) // size, 1)})

@bp.get("/api/admin/events.csv")
@auth.admin_required
def admin_events_csv():
    where, args = event_filters()
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";")
    writer.writerow([t("col_time"), "IP", t("col_pc"), t("col_employee"), t("col_action"), t("col_document"), t("col_path"), t("col_details")])
    for r in query(f"SELECT ts,ip,host,user,action,doc_name,path,details FROM events{where} ORDER BY id DESC", args):
        writer.writerow([r["ts"], r["ip"], r["host"], r["user"], t("act_" + r["action"]), r["doc_name"], r["path"], r["details"]])
    return send_file(io.BytesIO(output.getvalue().encode("utf-8-sig")), mimetype="text/csv; charset=utf-8", as_attachment=True,
                     download_name=f"documentation-stats-{datetime.now():%Y%m%d}.csv")

# ---------- Заявки ----------
@bp.get("/api/admin/submissions")
@auth.admin_required
def admin_submissions():
    status = request.args.get("status", "")
    rows = query("SELECT * FROM submissions" + (" WHERE status=?" if status else "") + " ORDER BY CASE status WHEN 'resubmitted' THEN 0 WHEN 'pending' THEN 1 WHEN 'changes' THEN 2 ELSE 3 END, id DESC LIMIT 500",
                 (status,) if status else ())
    for r in rows:
        r["files"] = subs.files_of(r["id"])
        r["has_exec"] = any(f["exec"] for f in r["files"])
        r["unread"] = query_one("SELECT COUNT(*) n FROM messages WHERE submission_id=? AND sender='user' AND read_admin=0", (r["id"],))["n"]
        r["kind"] = r.get("kind") or "add"
        r["move_rels"] = [moves.rel(p) for p in json.loads(r.get("move_paths") or "[]")]
    return jsonify({"items": rows})

@bp.get("/api/admin/submissions/<int:sub_id>")
@auth.admin_required
def admin_submission(sub_id):
    s = subs.get(sub_id)
    if not s: abort(404)
    s["messages"] = query("SELECT * FROM messages WHERE submission_id=? ORDER BY id", (sub_id,))
    s["move_items"] = [{"path": p, "rel": moves.rel(p), "exists": Path(p).exists(), "doc_name": (find_record(p) or {}).get("doc_name", Path(p).name)} for p in s["move_paths"]]
    s["impact"] = len(moves.affected_clients(s["move_paths"])) if s["kind"] == "move" else 0
    execute("UPDATE messages SET read_admin=1 WHERE submission_id=? AND sender='user'", (sub_id,))
    return jsonify(s)

@bp.post("/api/admin/submissions/<int:sub_id>")
@auth.admin_required
def admin_submission_update(sub_id):
    subs.admin_update(sub_id, request.get_json(silent=True) or {})
    return jsonify({"ok": True})

def notify(s, text, important=True):
    subs.send("admin", text, s["client_id"], s["host"], s["ip"], s["user"], s["id"], important)

@bp.post("/api/admin/submissions/<int:sub_id>/<action>")
@auth.admin_required
def admin_submission_action(sub_id, action):
    s = subs.get(sub_id)
    if not s: abort(404)
    d = request.get_json(silent=True) or {}
    text = (d.get("text") or "").strip()
    try:
        if action == "changes":
            if not text: return jsonify({"error": t("msg_err_empty")}), 400
            notify(s, text); subs.set_status(sub_id, "changes")
        elif action == "reject":
            notify(s, text or t("sub_auto_rejected", title=s["title"])); subs.set_status(sub_id, "rejected")
        elif action == "approve":
            if not auth.can_approve(): return jsonify({"error": t("sub_err_server_only")}), 403
            paths, scans = subs.approve(sub_id, allow_unscanned=bool(d.get("allow_unscanned")), notify=d.get("notify", True) is not False)
            if s["kind"] == "move":
                failed = {k: v for k, v in scans.items() if v != "ok"}
                if not failed: notify(s, text or t("mv_auto_approved", title=s["title"], target=s["target"].replace("/", " › ")), important=False)
                log_event("move", paths[0] if paths else "", s["title"], f"#{sub_id} → {s['target']} {json.dumps(failed, ensure_ascii=False) if failed else ''}", client=admin_client())
                print(f"[⇄] перенос по заявке #{sub_id}: {len(paths)} файл(ов) → {s['target']}")
                return jsonify({"ok": True, "paths": paths, "failed": failed})
            notify(s, text or t("sub_auto_approved", title=s["title"]), important=False)
            log_event("approve", paths[0] if paths else "", s["title"], f"#{sub_id} {json.dumps(scans, ensure_ascii=False)}", client=admin_client())
            print(f"[✓] заявка #{sub_id} одобрена: {', '.join(paths)}")
            return jsonify({"ok": True, "paths": paths, "scans": scans})
        elif action == "delete":
            subs.delete(sub_id)
        else:
            abort(404)
    except SubmissionError as e:
        return jsonify({"error": t(e.key, **e.params), "code": e.key}), 400
    log_event("sub_" + action, doc_name=s["title"], details=f"#{sub_id} {text[:120]}", client=admin_client())
    return jsonify({"ok": True})

# ---------- Перенос документов ----------
@bp.post("/api/admin/move-impact")
@auth.admin_required
def move_impact():
    """Сколько сотрудников открывали документы за 30 дней: напоминание перед переносом."""
    paths = (request.get_json(silent=True) or {}).get("paths") or []
    people = moves.affected_clients(paths)
    return jsonify({"count": len(people), "people": [f"{p['user']} ({p['host']})" for p in people][:30], "days": moves.NOTIFY_DAYS})

@bp.post("/api/admin/move")
@auth.admin_required
def move_now():
    d = request.get_json(silent=True) or {}
    if not auth.can_approve(): return jsonify({"error": t("sub_err_server_only")}), 403
    paths, target, reason = d.get("paths") or [], subs.clean_target(d.get("target")), (d.get("reason") or "").strip()[:2000]
    if not paths: return jsonify({"error": t("mv_err_nothing")}), 400
    if not target: return jsonify({"error": t("sub_err_target")}), 400
    results = moves.move_files(paths, target, "admin", reason, None, d.get("notify", True) is not False)
    ok = [r for r in results if r["ok"]]
    failed = {r["name"]: r["error"] for r in results if not r["ok"]}
    if ok: log_event("move", ok[0]["new"], ok[0].get("doc_name", ok[0]["name"]), f"{len(ok)} → {target} {reason[:100]}", client=admin_client())
    print(f"[⇄] администратор перенёс {len(ok)} файл(ов) → {target}" + (f", ошибок: {len(failed)}" if failed else ""))
    return jsonify({"ok": bool(ok), "moved": [r["new"] for r in ok], "failed": failed})

@bp.get("/api/admin/moves")
@auth.admin_required
def moves_list():
    rows = query("SELECT * FROM moves ORDER BY id DESC LIMIT 1000")
    for r in rows: r.update(old_rel=moves.rel(r["old_path"]), new_rel=moves.rel(r["new_path"]))
    return jsonify({"items": rows})

@bp.post("/api/admin/moves/<int:mid>/undo")
@auth.admin_required
def move_undo(mid):
    if not auth.can_approve(): return jsonify({"error": t("sub_err_server_only")}), 403
    err = moves.undo(mid, "admin")
    if err: return jsonify({"error": err}), 400
    log_event("move_undo", details=f"#{mid}", client=admin_client())
    return jsonify({"ok": True})

def sub_file(fid):
    f = query_one("SELECT * FROM submission_files WHERE id=?", (fid,))
    if not f: abort(404)
    p = subs.file_path(f)
    if not p.exists(): abort(404)
    return f, p

@bp.get("/api/admin/files/<int:fid>/preview")
@auth.admin_required
def sub_file_preview(fid):
    f, p = sub_file(fid)
    return jsonify(preview_payload(p, f"/api/admin/files/{fid}/raw"))

@bp.get("/api/admin/files/<int:fid>/raw")
@auth.admin_required
def sub_file_raw(fid):
    from .config import INLINE_EXTS
    f, p = sub_file(fid)
    download = request.args.get("download") == "1"
    if not download and p.suffix.lower() not in INLINE_EXTS: abort(409, t("err_inline_only"))
    resp = send_inline(p, download)
    if download: resp.headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(f["orig_name"])
    return resp

# ---------- Сообщения ----------
@bp.get("/api/admin/conversations")
@auth.admin_required
def conversations():
    rows = query("""SELECT client_id, MAX(id) last_id, SUM(CASE WHEN sender='user' AND read_admin=0 THEN 1 ELSE 0 END) unread, COUNT(*) n
                    FROM messages GROUP BY client_id ORDER BY unread DESC, last_id DESC LIMIT 300""")
    for r in rows:
        last = query_one("SELECT ts, text, sender, user, host, ip FROM messages WHERE id=?", (r["last_id"],))
        dev = query_one("SELECT user, host, ip FROM devices WHERE client_id=?", (r["client_id"],)) or {}
        r.update(last=last, user=dev.get("user") or last["user"], host=dev.get("host") or last["host"], ip=dev.get("ip") or last["ip"])
    return jsonify({"items": rows})

@bp.get("/api/admin/conversations/<cid>")
@auth.admin_required
def conversation(cid):
    rows = query("SELECT m.*, s.title submission_title FROM messages m LEFT JOIN submissions s ON s.id=m.submission_id WHERE m.client_id=? ORDER BY m.id", (cid,))
    execute("UPDATE messages SET read_admin=1 WHERE client_id=? AND sender='user'", (cid,))
    dev = query_one("SELECT * FROM devices WHERE client_id=?", (cid,))
    return jsonify({"items": rows, "device": dev})

@bp.post("/api/admin/messages")
@auth.admin_required
def admin_send():
    d = request.get_json(silent=True) or {}
    cid = (d.get("client_id") or "").strip()
    dev = query_one("SELECT * FROM devices WHERE client_id=?", (cid,))
    if not dev: return jsonify({"error": t("msg_err_device")}), 400
    try: subs.send("admin", d.get("text"), cid, dev["host"], dev["ip"], dev["user"], d.get("submission_id") or None, bool(d.get("important")))
    except SubmissionError as e: return jsonify({"error": t(e.key)}), 400
    log_event("admin_message", details=f"→ {dev['user']} ({dev['host']}): {str(d.get('text'))[:100]}", client=admin_client())
    return jsonify({"ok": True})

# ---------- Настройки ----------
def can_write_root():
    try:
        with tempfile.NamedTemporaryFile(dir=root(), prefix=".portal_write_test_", delete=True): return True
    except OSError:
        return False

@bp.get("/api/admin/system")
@auth.admin_required
def system():
    return jsonify({"soffice": SOFFICE, "ffmpeg": FFMPEG, "defender": DEFENDER, "pillow": Image is not None, "share": DOC_SHARE,
                    "root": str(root()), "writable": can_write_root(), "upload_max": UPLOAD_MAX_MB,
                    "allowed": sorted(e.lstrip(".") for e in ALLOWED_EXTS), "exec": sorted(e.lstrip(".") for e in EXEC_EXTS & ALLOWED_EXTS),
                    "pw_changed": query_one("SELECT value FROM settings WHERE key='admin_pw_changed'") or {}, "is_server": auth.is_server_request(), "can_approve": auth.can_approve()})

@bp.post("/api/admin/password")
@auth.admin_required
def change_password():
    d = request.get_json(silent=True) or {}
    if not auth.check_admin_password(d.get("current", "")): return jsonify({"error": t("pw_err_current")}), 400
    new = d.get("new", "")
    if len(new) < 6: return jsonify({"error": t("pw_err_short", n=6)}), 400
    if new != d.get("confirm", ""): return jsonify({"error": t("pw_err_mismatch")}), 400
    auth.set_admin_password(new)
    auth.login_session()  # текущий вход остаётся, остальные завершаются
    log_event("admin_password", client=admin_client())
    return jsonify({"ok": True})
