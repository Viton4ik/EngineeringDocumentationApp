"""Вход администратора (учётная запись admin): пароль задаётся при первом запуске на сервере и хранится только как хеш."""
from __future__ import annotations
import secrets
from datetime import timedelta, datetime
from functools import wraps
from flask import session, request, redirect, jsonify, abort
from werkzeug.security import generate_password_hash, check_password_hash
from .config import LOOPBACK, ADMIN_MIN_PASSWORD, APPROVE_ONLY_ON_SERVER
from .db import get_setting, set_setting, query_one

ADMIN_USER = "admin"
MAX_FAILS, LOCK_MINUTES = 5, 15

def secret_key():
    key = get_setting("secret_key")
    if not key:
        key = secrets.token_hex(32)
        set_setting("secret_key", key)
    return key

def has_admin_password():
    return bool(get_setting("admin_hash"))

def set_admin_password(password):
    if len(password) < ADMIN_MIN_PASSWORD: raise ValueError(f"min {ADMIN_MIN_PASSWORD}")
    try: hashed = generate_password_hash(password, method="scrypt")
    except (ValueError, AttributeError):  # Python без OpenSSL scrypt
        hashed = generate_password_hash(password, method="pbkdf2:sha256:600000")
    set_setting("admin_hash", hashed)
    set_setting("admin_pw_version", secrets.token_hex(8))  # все старые входы становятся недействительны
    set_setting("admin_pw_changed", datetime.now().isoformat(sep=" ", timespec="seconds"))

def check_admin_password(password):
    hashed = get_setting("admin_hash")
    return bool(hashed) and check_password_hash(hashed, password or "")

def recent_failures(ip):
    since = (datetime.now() - timedelta(minutes=LOCK_MINUTES)).isoformat(sep=" ", timespec="seconds")
    last_ok = query_one("SELECT MAX(ts) ts FROM events WHERE action='admin_login' AND ip=?", (ip,))
    if last_ok and last_ok["ts"] and last_ok["ts"] > since: since = last_ok["ts"]
    return query_one("SELECT COUNT(*) n FROM events WHERE action='admin_login_fail' AND ip=? AND ts>?", (ip, since))["n"]

def is_locked(ip):
    return recent_failures(ip) >= MAX_FAILS

def login_session():
    session.clear()
    session.permanent = True
    session["admin"] = True
    session["pwv"] = get_setting("admin_pw_version")

def is_admin():
    return bool(session.get("admin")) and session.get("pwv") == get_setting("admin_pw_version") and has_admin_password()

def is_server_request():
    """Запрос пришёл с самого серверного ПК."""
    return (request.remote_addr or "") in LOOPBACK

def can_approve():
    return is_server_request() or not APPROVE_ONLY_ON_SERVER

def admin_required(view):
    @wraps(view)
    def wrapper(*a, **kw):
        if not is_admin():
            if request.path.startswith("/api/"): return jsonify({"error": "auth"}), 401
            return redirect("/admin/login?next=" + request.path)
        return view(*a, **kw)
    return wrapper

def server_only(view):
    @wraps(view)
    def wrapper(*a, **kw):
        if not is_server_request(): abort(403)
        return view(*a, **kw)
    return wrapper
