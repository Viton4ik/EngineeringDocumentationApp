"""Страницы и API для сотрудников."""
from __future__ import annotations
import io, csv, json
from pathlib import Path
from urllib.parse import quote
from flask import Blueprint, render_template, request, jsonify, send_file, abort, Response, redirect
from .config import HOST, DOC_SHARE, SHARE_NAME, INLINE_EXTS, TEXT_EXTS, CACHE_DIR, UPLOAD_MAX_MB, ALLOWED_EXTS, file_kind
from .catalog import CACHE, TITLES, LOCK, root, make_unc, find_record, scan_documents
from .clients import current_client, log_event, hello as client_hello, bye as client_bye, active_sessions
from .preview import preview_payload
from . import moves
from . import submissions as subs
from .submissions import SubmissionError
from .auth import is_admin
from .i18n import t, LANGS

bp = Blueprint("public", __name__)

def moved_redirect(endpoint):
    """Старая ссылка на перенесённый документ ведёт на новое место; страница покажет окно «Документ перенесён»."""
    raw = request.args.get("path", "")
    if raw and not Path(raw).exists():
        new = moves.latest_location(str(Path(raw)))
        if new and Path(new).exists():
            return redirect(f"/{endpoint}?path={quote(new)}&moved_from={quote(raw)}")
    return None

def safe_path(raw):
    base = root()
    if not raw: abort(400)
    p = Path(raw).resolve()
    try: p.relative_to(base)
    except ValueError: abort(403)
    if not p.exists() or not p.is_file(): abort(404)
    return p

def common():
    return dict(host=HOST, root=str(root()), share=DOC_SHARE, is_admin=is_admin())

def sub_error(e: SubmissionError):
    return jsonify({"error": t(e.key, **e.params)}), 400

@bp.get("/lang/<code>")
def set_lang(code):
    resp = redirect(request.referrer or "/")
    if code in LANGS: resp.set_cookie("lang", code, max_age=3 * 365 * 86400, samesite="Lax")
    return resp

@bp.get("/")
def index():
    with LOCK: snap = dict(CACHE)
    return render_template("index.html", count=len(snap["files"]), error=snap["error"], scanned_at=snap["scanned_at"] or "—",
                           upload_max=UPLOAD_MAX_MB, allowed=sorted(e.lstrip(".") for e in ALLOWED_EXTS), **common())

@bp.get("/view")
def view():
    r = moved_redirect("view")
    if r: return r
    p = safe_path(request.args.get("path", ""))
    rec = find_record(p) or {"name": p.name, "doc_name": p.name, "path": str(p), "unc": make_unc(p), "extension": p.suffix.lower(),
                             "kind": file_kind(p.suffix.lower()), "title_source": "file", "description": ""}
    return render_template("view.html", doc=rec, moved_from=request.args.get("moved_from", ""), **common())

@bp.get("/document")
def document():
    r = moved_redirect("document")
    if r: return r
    p = safe_path(request.args.get("path", ""))
    record = find_record(p)
    if not record:
        scan_documents()
        record = find_record(p)
    if not record: abort(404)
    log_event("properties", record["path"], record["doc_name"])
    return render_template("properties.html", doc=record, history=moves.history_for(record["path"]), moved_from=request.args.get("moved_from", ""), **common())

@bp.get("/api/files")
def api_files():
    with LOCK:
        snap = dict(CACHE)
        version = len(TITLES["log"])
    return jsonify({"files": snap["files"], "folders": snap["folders"], "error": snap["error"], "root": str(root()), "host": HOST,
                    "scanned_at": snap["scanned_at"], "siemens_count": snap["siemens_count"], "titles_version": version})

@bp.get("/api/folders")
def api_folders():
    with LOCK: return jsonify({"folders": list(CACHE["folders"])})

@bp.get("/api/moves/recent")
def api_recent_moves():
    return jsonify({"items": moves.recent(int(request.args.get("days", 90) or 90))})

@bp.get("/api/moves/for")
def api_moves_for():
    return jsonify({"items": moves.history_for(str(Path(request.args.get("path", ""))))})

@bp.post("/api/my/moves")
def propose_move():
    client = current_client()
    d = request.get_json(silent=True) or {}
    try: sub_id = subs.create_move(d.get("paths") or [], d.get("target"), d.get("reason"), client)
    except SubmissionError as e: return sub_error(e)
    log_event("move_request", doc_name=str(len(d.get("paths") or [])), details=f"#{sub_id} → {d.get('target', '')}", client=client)
    print(f"[⇄] заявка на перенос #{sub_id} от {client['user']} ({client['host']})")
    return jsonify({"id": sub_id})

@bp.get("/api/titles")
def api_titles():
    since = max(int(request.args.get("since", 0) or 0), 0)
    with LOCK:
        changes = TITLES["log"][since:since + 5000]  # для одобренных файлов четвёртым элементом идёт вся запись
        return jsonify({"running": TITLES["running"], "done": TITLES["done"], "total": TITLES["total"], "found": TITLES["found"],
                        "version": len(TITLES["log"]), "changes": changes})

@bp.post("/api/refresh")
def refresh():
    log_event("rescan")
    files, error = scan_documents()
    return jsonify({"count": len(files), "error": error, "scanned_at": CACHE["scanned_at"], "siemens_count": CACHE["siemens_count"]})

@bp.post("/api/hello")
def hello():
    client = client_hello(request.get_json(silent=True) or {})
    unread, important = subs.unread_for_client(client)
    return jsonify({"user": client["user"], "host": client["host"], "ip": client["ip"], "active": len(active_sessions()),
                    "unread": unread, "important": important, "is_admin": is_admin()})

@bp.post("/api/bye")
def bye():
    client_bye()
    return "", 204

@bp.post("/api/log")
def api_log():
    data = request.get_json(silent=True) or {}
    action = str(data.get("action", ""))
    if action not in {"copy_path", "open_app", "open"}: abort(400)
    rec = find_record(data.get("path", "")) or {}
    log_event(action, rec.get("path", ""), rec.get("doc_name", ""), str(data.get("details", ""))[:200])
    return "", 204

@bp.get("/api/preview")
def preview():
    p = safe_path(request.args.get("path", ""))
    if request.args.get("log") != "0":
        rec = find_record(p)
        log_event("preview", str(p), rec["doc_name"] if rec else p.name)
    return jsonify(preview_payload(p, "/api/raw?path=" + quote(str(p))))

def send_inline(p: Path, download: bool):
    resp = send_file(p, conditional=True, download_name=p.name, as_attachment=download)
    resp.headers["Content-Security-Policy"] = "sandbox; default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    if p.suffix.lower() in TEXT_EXTS and not download: resp.headers["Content-Type"] = "text/plain; charset=utf-8"
    return resp

@bp.get("/api/raw")
def raw():
    p = safe_path(request.args.get("path", ""))
    download = request.args.get("download") == "1"
    if not download and p.suffix.lower() not in INLINE_EXTS: abort(409, t("err_inline_only"))
    if download:
        rec = find_record(p)
        log_event("download", str(p), rec["doc_name"] if rec else p.name)
    return send_inline(p, download)

@bp.get("/api/cache/<name>")
@bp.get("/api/cache/<name>/<path:display>")
def cached_file(name, display=None):
    import re
    if not re.fullmatch(r"[0-9a-f]{40}\.(pdf|png|mp4|mp3)", name): abort(404)
    f = CACHE_DIR / name
    if not f.exists(): abort(404)
    return send_file(f, conditional=True)

@bp.get("/api/export.csv")
def export_csv():
    with LOCK: records = list(CACHE["files"])
    output = io.StringIO(newline="")
    fields = ["documentation", "rfq", "system", "unit", "name", "doc_name", "title_source", "description", "extension", "size", "modified", "relative", "unc"]
    writer = csv.DictWriter(output, fieldnames=fields); writer.writeheader()
    writer.writerows([{k: r.get(k, "") for k in fields} for r in records])
    return send_file(io.BytesIO(output.getvalue().encode("utf-8-sig")), mimetype="text/csv; charset=utf-8", as_attachment=True, download_name="documentation-list.csv")

# ---------- Заявки сотрудника ----------
@bp.get("/api/my/submissions")
def my_submissions():
    return jsonify({"items": subs.list_for_client(current_client())})

@bp.post("/api/my/submissions")
def submit():
    client = current_client()
    try: sub_id = subs.create(request.form, request.files.getlist("files"), client)
    except SubmissionError as e: return sub_error(e)
    log_event("submit", doc_name=request.form.get("title", ""), details=f"#{sub_id}", client=client)
    print(f"[✉] новая заявка #{sub_id} от {client['user']} ({client['host']}): {request.form.get('title', '')}")
    return jsonify({"id": sub_id})

@bp.post("/api/my/submissions/<int:sub_id>")
def resubmit(sub_id):
    client = current_client()
    s = subs.get(sub_id)
    if not subs.owned_by(s, client): abort(404)
    try: subs.user_update(s, request.form, request.files.getlist("files"), request.form.getlist("remove"))
    except SubmissionError as e: return sub_error(e)
    log_event("resubmit", doc_name=request.form.get("title", ""), details=f"#{sub_id}", client=client)
    return jsonify({"id": sub_id})

@bp.get("/api/my/messages")
def my_messages():
    client = current_client()
    rows = subs.messages_for_client(client)
    titles = {s["id"]: s["title"] for s in subs.list_for_client(client)}
    for r in rows: r["submission_title"] = titles.get(r["submission_id"], "")
    subs.mark_read_client(client)
    return jsonify({"items": rows})

@bp.post("/api/my/messages")
def my_send():
    client = current_client()
    data = request.get_json(silent=True) or {}
    sub_id = data.get("submission_id") or None
    if sub_id and not subs.owned_by(subs.get(int(sub_id)), client): abort(404)
    try: subs.send("user", data.get("text"), client["client_id"], client["host"], client["ip"], client["user"], sub_id)
    except SubmissionError as e: return sub_error(e)
    log_event("message", details=str(data.get("text", ""))[:120], client=client)
    return jsonify({"ok": True})

# ---------- Помощник «Открыть в программе» ----------
HELPER_PS1 = r"""param([string]$Url)
$allowed = @('__PREFIX__')
$blocked = '.exe','.bat','.cmd','.com','.ps1','.vbs','.vbe','.js','.jse','.wsf','.hta','.msi','.scr','.lnk','.reg','.pif','.cpl'
try {
  $p = [Uri]::UnescapeDataString(($Url -replace '^docopen:', '')).Trim().TrimEnd('/')
  if (-not ($allowed | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) -or $p.Contains('..')) { throw "Path outside documentation / Путь вне каталога: $p" }
  if ($blocked -contains [IO.Path]::GetExtension($p).ToLower()) { throw "Programs are not started from the catalog / Программы из каталога не запускаются: $p" }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "File not found or no access / Файл не найден или нет доступа: $p" }
  Invoke-Item -LiteralPath $p
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, 'GASTRANS Documentation') | Out-Null
}
"""

HELPER_CMD = r"""@echo off
chcp 65001 >nul
echo GASTRANS Documentation: "docopen" helper
set "D=%LOCALAPPDATA%\DocPortal"
if not exist "%D%" mkdir "%D%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing '__SERVER__/helper/docopen.ps1' -OutFile '%D%\docopen.ps1'"
if errorlevel 1 (echo Download failed / Ошибка загрузки docopen.ps1 & pause & exit /b 1)
reg add "HKCU\Software\Classes\docopen" /ve /d "URL:GASTRANS Documentation" /f >nul
reg add "HKCU\Software\Classes\docopen" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\docopen\shell\open\command" /ve /d "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%D%\docopen.ps1\" \"%%1\"" /f >nul
__ZONE__
echo OK. Готово. Gotovo.
pause
"""

def share_prefixes():
    """Помощник принимает путь к общей папке и по имени сервера, и по любому его адресу."""
    if not SHARE_NAME: return [make_unc(root() / "x")[:-1].rstrip("\\") + "\\"]
    import socket
    hosts = {HOST, HOST.upper(), request.host.split(":")[0]}
    if DOC_SHARE.startswith("\\\\"): hosts.add(DOC_SHARE.lstrip("\\").split("\\")[0])
    try: hosts.update(i[4][0] for i in socket.getaddrinfo(HOST, None, socket.AF_INET))
    except OSError: pass
    return sorted("\\\\" + h + "\\" + SHARE_NAME + "\\" for h in hosts if h and not h.startswith("127."))

def zone_commands(host):
    """Путь по IP Windows относит к зоне «Интернет» (предупреждения, защищённый просмотр Office).
    Добавляем сервер в «Местную интрасеть» для текущего пользователя, права администратора не нужны."""
    import ipaddress
    base = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap"
    try:
        ipaddress.ip_address(host)
        key = base + r"\Ranges\GastransDocs"
        return (f'reg add "{key}" /v ":Range" /d "{host}" /f >nul\n'
                f'reg add "{key}" /v "file" /t REG_DWORD /d 1 /f >nul')
    except ValueError:
        return f'reg add "{base}\\Domains\\{host}" /v "file" /t REG_DWORD /d 1 /f >nul'

@bp.get("/helper/docopen.ps1")
def helper_ps1():
    allowed = ",".join("'" + p.replace("'", "''") + "'" for p in share_prefixes())
    body = HELPER_PS1.replace("'__PREFIX__'", allowed).replace("\n", "\r\n")
    return Response("﻿" + body, mimetype="text/plain; charset=utf-8", headers={"Content-Disposition": "attachment; filename=docopen.ps1"})

@bp.get("/helper/install.cmd")
def helper_cmd():
    log_event("helper_install")
    body = HELPER_CMD.replace("__SERVER__", request.host_url.rstrip("/")).replace("__ZONE__", zone_commands(request.host.split(":")[0])).replace("\n", "\r\n")
    return Response(body.encode("utf-8"), mimetype="application/octet-stream", headers={"Content-Disposition": "attachment; filename=gastrans-docopen-install.cmd"})
