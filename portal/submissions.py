"""Заявки сотрудников на внесение документов и переписка с администратором."""
from __future__ import annotations
import re, json, shutil, hashlib, subprocess
from pathlib import Path
from .config import SUBMIT_DIR, ALLOWED_EXTS, EXEC_EXTS, DEFENDER, UPLOAD_MAX_MB
from .db import execute, query, query_one, now_str
from .catalog import root, add_files

STATUSES = ("pending", "resubmitted", "changes", "approved", "rejected")
FIELDS = ("title", "description", "doc_type", "revision", "documentation", "rfq", "system", "unit", "comment")
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

class SubmissionError(ValueError):
    """Ошибка проверки заявки; args[0] - ключ перевода, kwargs - параметры."""
    def __init__(self, key, **params):
        super().__init__(key); self.key, self.params = key, params

def safe_name(name, default="file"):
    """Как secure_filename, но сохраняет кириллицу и сербскую латиницу."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or "")).strip(" .")
    name = re.sub(r"\s+", " ", name)[:150]
    if not name or name.split(".")[0].upper() in RESERVED: name = "_" + (name or default)
    return name

def safe_folder(part):
    part = safe_name(part, "")
    return "" if part in ("", ".", "..", "_") else part

def clean_fields(form):
    data = {k: str(form.get(k, "") or "").strip() for k in FIELDS}
    limits = {"title": 200, "description": 4000, "comment": 2000}
    for k in data: data[k] = data[k][:limits.get(k, 120)]
    if not data["title"]: raise SubmissionError("sub_err_title")
    if not data["description"]: raise SubmissionError("sub_err_description")
    return data

def check_files(files):
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in ALLOWED_EXTS: raise SubmissionError("sub_err_ext", name=f.filename, ext=ext or "—")

def store_files(sub_id, files):
    folder = SUBMIT_DIR / str(sub_id)
    folder.mkdir(parents=True, exist_ok=True)
    for f in files:
        orig = safe_name(Path(f.filename).name)
        fid = execute("INSERT INTO submission_files(submission_id,orig_name,stored_name,size,ext,sha256,added_at) VALUES(?,?,?,?,?,?,?)",
                      (sub_id, orig, "", 0, Path(orig).suffix.lower(), "", now_str()))
        stored = f"{fid}_{orig}"
        target = folder / stored
        f.save(target)
        digest = hashlib.sha256()
        with target.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""): digest.update(chunk)
        execute("UPDATE submission_files SET stored_name=?, size=?, sha256=? WHERE id=?", (stored, target.stat().st_size, digest.hexdigest(), fid))

def create(form, files, client):
    data = clean_fields(form)
    files = [f for f in files if f and f.filename]
    if not files: raise SubmissionError("sub_err_files")
    check_files(files)
    now = now_str()
    sub_id = execute(f"INSERT INTO submissions(created_at,updated_at,status,client_id,user,ip,host,{','.join(FIELDS)}) VALUES(?,?,?,?,?,?,?,{','.join('?' * len(FIELDS))})",
                     (now, now, "pending", client["client_id"], client["user"], client["ip"], client["host"], *[data[k] for k in FIELDS]))
    store_files(sub_id, files)
    return sub_id

def files_of(sub_id):
    rows = query("SELECT * FROM submission_files WHERE submission_id=? AND removed=0 ORDER BY id", (sub_id,))
    for r in rows: r["exec"] = r["ext"] in EXEC_EXTS
    return rows

def get(sub_id):
    s = query_one("SELECT * FROM submissions WHERE id=?", (sub_id,))
    if s:
        s["files"] = files_of(sub_id)
        s["approved_paths"] = json.loads(s["approved_paths"] or "[]")
        s["has_exec"] = any(f["exec"] for f in s["files"])
    return s

def owned_by(s, client):
    host = client["host"]
    return s and (s["client_id"] == client["client_id"] or (host and host != client["ip"] and s["host"] == host))

def list_for_client(client):
    rows = query("SELECT * FROM submissions WHERE client_id=? OR (host=? AND host<>ip) ORDER BY id DESC", (client["client_id"], client["host"]))
    for r in rows: r["files"] = files_of(r["id"])
    return rows

def user_update(s, form, files, remove_ids):
    if s["status"] not in ("changes", "pending", "resubmitted"): raise SubmissionError("sub_err_locked")
    data = clean_fields(form)
    files = [f for f in files if f and f.filename]
    check_files(files)
    for fid in remove_ids:
        execute("UPDATE submission_files SET removed=1 WHERE id=? AND submission_id=?", (int(fid), s["id"]))
    store_files(s["id"], files)
    if not files_of(s["id"]): raise SubmissionError("sub_err_files")
    status = "resubmitted" if s["status"] == "changes" else s["status"]
    execute(f"UPDATE submissions SET {', '.join(k + '=?' for k in FIELDS)}, status=?, updated_at=? WHERE id=?", (*[data[k] for k in FIELDS], status, now_str(), s["id"]))

def admin_update(sub_id, form):
    data = {k: str(form.get(k, "") or "").strip()[:4000] for k in FIELDS if k in form}
    if data: execute(f"UPDATE submissions SET {', '.join(k + '=?' for k in data)}, updated_at=? WHERE id=?", (*data.values(), now_str(), sub_id))

def set_status(sub_id, status):
    execute("UPDATE submissions SET status=?, updated_at=?, decided_at=CASE WHEN ? IN ('approved','rejected') THEN ? ELSE decided_at END WHERE id=?",
            (status, now_str(), status, now_str(), sub_id))

def file_path(f):
    return SUBMIT_DIR / str(f["submission_id"]) / f["stored_name"]

def defender_scan(path: Path):
    """'clean' / 'threat' / 'unavailable' / 'error'. Код 2 у MpCmdRun означает найденную угрозу."""
    if not DEFENDER: return "unavailable"
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        r = subprocess.run([DEFENDER, "-Scan", "-ScanType", "3", "-File", str(path), "-DisableRemediation"], capture_output=True, timeout=600, creationflags=flags)
    except (OSError, subprocess.SubprocessError):
        return "error"
    return {0: "clean", 2: "threat"}.get(r.returncode, "error")

def unique_target(folder: Path, name):
    target = folder / name
    stem, ext, n = target.stem, target.suffix, 2
    while target.exists():
        target = folder / f"{stem}_{n}{ext}"; n += 1
    return target

def approve(sub_id, allow_unscanned=False):
    """Проверка антивирусом и копирование в каталог. Возвращает (пути, результаты проверки)."""
    s = get(sub_id)
    if not s or s["status"] in ("approved", "rejected"): raise SubmissionError("sub_err_locked")
    if not s["files"]: raise SubmissionError("sub_err_files")
    scans = {}
    for f in s["files"]:
        result = defender_scan(file_path(f))
        scans[f["orig_name"]] = result
        execute("UPDATE submission_files SET scan=? WHERE id=?", (result, f["id"]))
        if result == "threat": raise SubmissionError("sub_err_threat", name=f["orig_name"])
        if result in ("unavailable", "error") and not allow_unscanned: raise SubmissionError("sub_err_unscanned", name=f["orig_name"])
    folder = root()
    for part in (s["documentation"], s["rfq"], s["system"], s["unit"]):
        part = safe_folder(part)
        if part: folder = folder / part
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for f in s["files"]:
        target = unique_target(folder, f["orig_name"])
        shutil.copy2(file_path(f), target)
        paths.append(str(target.resolve()))
        execute("INSERT OR REPLACE INTO doc_meta(path,title,description,submission_id,approved_at) VALUES(?,?,?,?,?)",
                (paths[-1], s["title"], s["description"], sub_id, now_str()))
    execute("UPDATE submissions SET approved_paths=? WHERE id=?", (json.dumps(paths, ensure_ascii=False), sub_id))
    set_status(sub_id, "approved")
    add_files(paths)
    return paths, scans

def delete(sub_id):
    shutil.rmtree(SUBMIT_DIR / str(sub_id), ignore_errors=True)
    execute("DELETE FROM submission_files WHERE submission_id=?", (sub_id,))
    execute("DELETE FROM submissions WHERE id=?", (sub_id,))
    execute("UPDATE messages SET submission_id=NULL WHERE submission_id=?", (sub_id,))

# ---------- Сообщения ----------
def send(sender, text, client_id, host, ip, user, submission_id=None, important=False):
    text = str(text or "").strip()[:4000]
    if not text: raise SubmissionError("msg_err_empty")
    return execute("INSERT INTO messages(ts,sender,client_id,host,ip,user,submission_id,text,important,read_user,read_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (now_str(), sender, client_id, host, ip, user, submission_id, text, 1 if important else 0, 1 if sender == "user" else 0, 1 if sender == "admin" else 0))

def _client_where(client):
    return "(client_id=? OR (host=? AND host<>ip))", (client["client_id"], client["host"])

def messages_for_client(client):
    where, args = _client_where(client)
    return query(f"SELECT * FROM messages WHERE {where} ORDER BY id", args)

def unread_for_client(client):
    where, args = _client_where(client)
    rows = query(f"SELECT id, important, text, submission_id FROM messages WHERE sender='admin' AND read_user=0 AND {where} ORDER BY id", args)
    return len(rows), [r for r in rows if r["important"]]

def mark_read_client(client):
    where, args = _client_where(client)
    execute(f"UPDATE messages SET read_user=1 WHERE sender='admin' AND {where}", args)

def max_upload_bytes():
    return UPLOAD_MAX_MB * 1024 * 1024
