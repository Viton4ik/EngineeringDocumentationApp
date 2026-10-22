"""Перенос документов между разделами: только администратор (напрямую или по заявке сотрудника)."""
from __future__ import annotations
import shutil
from pathlib import Path
from datetime import datetime, timedelta
from .db import execute, query, query_one, now_str
from .catalog import root, find_record, move_record
from .i18n import t

NOTIFY_DAYS = 30
VIEW_ACTIONS = ("preview", "open", "open_app", "download", "copy_path", "properties")

def inside_root(p: Path):
    try:
        p.resolve().relative_to(root()); return True
    except ValueError:
        return False

def rel(path):
    try: return str(Path(path).relative_to(root())).replace("/", "\\")
    except ValueError: return str(path)

def affected_clients(paths, days=NOTIFY_DAYS):
    """Кто открывал эти документы за последние дни: им придёт уведомление о новом месте."""
    if not paths: return []
    since = (datetime.now() - timedelta(days=days)).isoformat(sep=" ", timespec="seconds")
    marks = ",".join("?" * len(paths))
    return query(f"""SELECT client_id, MAX(user) user, MAX(host) host, MAX(ip) ip FROM events
                     WHERE path IN ({marks}) AND ts>=? AND client_id<>'' AND user NOT IN ('admin','—') AND action IN {VIEW_ACTIONS}
                     GROUP BY client_id""", (*paths, since))

def latest_location(old_path):
    """Куда в итоге переехал файл (с учётом цепочки переносов)."""
    path, seen = old_path, set()
    while path not in seen:
        seen.add(path)
        m = query_one("SELECT * FROM moves WHERE old_path=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1", (path,))
        if not m: break
        path = m["new_path"]
    return path if path != old_path else None

def move_files(paths, target_rel, who, reason, submission_id=None, notify=True):
    """Переносит файлы в папку target_rel. Каждый файл обрабатывается отдельно: занятый файл не мешает остальным."""
    from .submissions import clean_target, unique_target, send
    target_rel = clean_target(target_rel)
    folder = root().joinpath(*target_rel.split("/")) if target_rel else root()
    results, moved = [], []
    for raw in paths:
        old = Path(raw)
        res = {"old": str(old), "name": old.name, "ok": False, "new": "", "error": ""}
        results.append(res)
        if not old.exists():
            done = latest_location(str(old))  # уже перенесён при прошлой попытке
            if done and Path(done).exists(): res.update(ok=True, new=done)
            else: res["error"] = t("mv_err_missing", name=old.name)
            continue
        if not inside_root(old) or not inside_root(folder):
            res["error"] = t("mv_err_outside"); continue
        if old.parent.resolve() == folder.resolve():
            res["error"] = t("mv_err_same", name=old.name); continue
        try:
            folder.mkdir(parents=True, exist_ok=True)
            new = unique_target(folder, old.name)
            rec = find_record(str(old)) or {}
            shutil.move(str(old), str(new))
        except PermissionError:
            res["error"] = t("mv_err_locked", name=old.name); continue
        except OSError as e:
            res["error"] = t("mv_err_os", name=old.name, error=e); continue
        new_s, old_s = str(new.resolve()), str(old)
        # всё, что известно о файле, переезжает вместе с ним, включая статистику
        for table in ("titles", "doc_meta"):
            execute(f"UPDATE {table} SET path=? WHERE path=?", (new_s, old_s))
        execute("UPDATE events SET path=? WHERE path=?", (new_s, old_s))
        execute("INSERT INTO moves(ts,old_path,new_path,doc_name,who,reason,submission_id) VALUES(?,?,?,?,?,?,?)",
                (now_str(), old_s, new_s, rec.get("doc_name", old.name), who, reason, submission_id))
        move_record(old_s, new_s)
        res.update(ok=True, new=new_s, doc_name=rec.get("doc_name", old.name))
        moved.append(res)
    if notify and moved:
        notify_moved(moved, reason)
    return results

def notify_moved(moved, reason):
    from .submissions import send
    by_client = {}
    for m in moved:
        for c in affected_clients([m["new"]]):  # события уже переписаны на новый путь
            by_client.setdefault(c["client_id"], (c, []))[1].append(m)
    for cid, (c, items) in by_client.items():
        lines = [t("mv_notify_line", name=m.get("doc_name") or m["name"], old=rel(m["old"]), new=rel(m["new"])) for m in items]
        text = t("mv_notify_head") + "\n\n" + "\n\n".join(lines) + ("\n\n" + t("reason") + ": " + reason if reason else "") + "\n\n" + t("mv_notify_tail")
        send("admin", text, cid, c["host"], c["ip"], c["user"], None, important=True)
    if by_client:
        ids = [m["new"] for m in moved]
        execute(f"UPDATE moves SET notified=? WHERE new_path IN ({','.join('?' * len(ids))})", (len(by_client), *ids))

def undo(move_id, who):
    m = query_one("SELECT * FROM moves WHERE id=?", (move_id,))
    if not m or m["undone_at"]: return t("mv_err_undo_state")
    new, old = Path(m["new_path"]), Path(m["old_path"])
    if not new.exists(): return t("mv_err_missing", name=new.name)
    if old.exists(): return t("mv_err_undo_occupied", path=rel(old))
    try:
        old.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(new), str(old))
    except PermissionError:
        return t("mv_err_locked", name=new.name)
    except OSError as e:
        return t("mv_err_os", name=new.name, error=e)
    for table in ("titles", "doc_meta"):
        execute(f"UPDATE {table} SET path=? WHERE path=?", (str(old), str(new)))
    execute("UPDATE events SET path=? WHERE path=?", (str(old), str(new)))
    execute("UPDATE moves SET undone_at=? WHERE id=?", (now_str(), move_id))
    move_record(str(new), str(old))
    return None

def recent(days=90):
    since = (datetime.now() - timedelta(days=days)).isoformat(sep=" ", timespec="seconds")
    rows = query("SELECT id, ts, old_path, new_path, doc_name, who, reason FROM moves WHERE ts>=? AND undone_at IS NULL ORDER BY id DESC LIMIT 500", (since,))
    for r in rows: r.update(old_rel=rel(r["old_path"]), new_rel=rel(r["new_path"]))
    return rows

def history_for(path):
    """Все перемещения файла по цепочке: откуда он пришёл и куда уходил."""
    paths, rows, seen = {path}, {}, -1
    while len(rows) != seen:
        seen = len(rows)
        marks = ",".join("?" * len(paths))
        for r in query(f"SELECT * FROM moves WHERE new_path IN ({marks}) OR old_path IN ({marks})", (*paths, *paths)):
            rows[r["id"]] = r; paths.update((r["old_path"], r["new_path"]))
    rows = [rows[k] for k in sorted(rows)]
    for r in rows: r.update(old_rel=rel(r["old_path"]), new_rel=rel(r["new_path"]))
    return rows
