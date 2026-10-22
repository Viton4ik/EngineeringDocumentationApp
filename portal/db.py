from __future__ import annotations
import sqlite3, threading
from datetime import datetime
from .config import DB_FILE

DB_LOCK = threading.Lock()

def db():
    con = sqlite3.connect(DB_FILE, timeout=15)
    con.row_factory = sqlite3.Row
    return con

def now_str():
    return datetime.now().isoformat(sep=" ", timespec="seconds")

def execute(sql, args=()):
    with DB_LOCK, db() as con:
        cur = con.execute(sql, args)
        return cur.lastrowid

def query(sql, args=()):
    with db() as con:
        return [dict(r) for r in con.execute(sql, args)]

def query_one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None

SCHEMA = """
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT, ip TEXT, host TEXT, user TEXT,
    client_id TEXT, action TEXT, path TEXT, doc_name TEXT, details TEXT);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_action ON events(action, ts);
CREATE TABLE IF NOT EXISTS titles(path TEXT PRIMARY KEY, mtime REAL, size INTEGER, title TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS devices(client_id TEXT PRIMARY KEY, user TEXT, ip TEXT, host TEXT, os TEXT, browser TEXT,
    screen TEXT, lang TEXT, tz TEXT, first_seen TEXT, last_seen TEXT, visits INTEGER DEFAULT 0, names TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY, ip TEXT, host TEXT, client_id TEXT, user TEXT, reason TEXT,
    created_at TEXT, until TEXT, active INTEGER DEFAULT 1, removed_at TEXT);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY, created_at TEXT, updated_at TEXT, status TEXT,
    client_id TEXT, user TEXT, ip TEXT, host TEXT, title TEXT, description TEXT, doc_type TEXT, revision TEXT,
    documentation TEXT, rfq TEXT, system TEXT, unit TEXT, comment TEXT, decided_at TEXT, approved_paths TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS submission_files(id INTEGER PRIMARY KEY, submission_id INTEGER, orig_name TEXT, stored_name TEXT,
    size INTEGER, ext TEXT, sha256 TEXT, added_at TEXT, removed INTEGER DEFAULT 0, scan TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ts TEXT, sender TEXT, client_id TEXT, host TEXT, ip TEXT, user TEXT,
    submission_id INTEGER, text TEXT, important INTEGER DEFAULT 0, read_user INTEGER DEFAULT 0, read_admin INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_messages_client ON messages(client_id);
CREATE TABLE IF NOT EXISTS doc_meta(path TEXT PRIMARY KEY, title TEXT, description TEXT, submission_id INTEGER, approved_at TEXT);
CREATE TABLE IF NOT EXISTS moves(id INTEGER PRIMARY KEY, ts TEXT, old_path TEXT, new_path TEXT, doc_name TEXT, who TEXT, reason TEXT,
    submission_id INTEGER, notified INTEGER DEFAULT 0, undone_at TEXT);
CREATE INDEX IF NOT EXISTS ix_moves_old ON moves(old_path);
"""

# Столбцы, добавленные в v4: старые базы дополняются при запуске, данные не теряются.
MIGRATIONS = [("submissions", "kind", "TEXT DEFAULT 'add'"), ("submissions", "target", "TEXT DEFAULT ''"),
              ("submissions", "move_paths", "TEXT DEFAULT '[]'")]

def init_db():
    with DB_LOCK, db() as con:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(SCHEMA)
        for table, column, decl in MIGRATIONS:
            if column not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

def get_setting(key, default=None):
    row = query_one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else default

def set_setting(key, value):
    execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, value))
