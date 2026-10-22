"""Сотрудники без учётных записей: браузер (cookie cid) + IP + имя ПК. Сессии, устройства, блокировки, журнал."""
from __future__ import annotations
import re, json, time, uuid, socket, threading, subprocess, ipaddress
from datetime import datetime
from flask import request, g
from .config import HOST, LOOPBACK, ACTIVE_SECONDS
from .db import execute, query, query_one, now_str

SESSIONS, HOSTNAMES = {}, {}
BLOCKS = []          # активные блокировки, кэш таблицы blocks
STATE_LOCK = threading.RLock()

def now_hm(): return datetime.now().strftime("%H:%M:%S")

def is_private(ip):
    try: return ipaddress.ip_address(ip).is_private or ipaddress.ip_address(ip).is_loopback
    except ValueError: return False

# ---------- Имя ПК: обратный DNS, затем NetBIOS ----------
def netbios_name(ip):
    """nbtstat есть только в Windows; в домене обычно хватает DNS, NetBIOS выручает в рабочих группах."""
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.run(["nbtstat", "-A", ip], capture_output=True, timeout=6, creationflags=flags).stdout.decode("cp866", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"^\s*([A-Za-z0-9\-_.]{1,15})\s+<00>\s+UNIQUE", out, re.M)
    return m.group(1).upper() if m else None

def lookup_host(ip):
    try:
        name = socket.gethostbyaddr(ip)[0].split(".")[0].upper()
        if name and name != ip: return name
    except OSError:
        pass
    return netbios_name(ip) or ip

def resolve_host(ip):
    if ip in LOOPBACK: return HOST.upper()
    cached = HOSTNAMES.get(ip)
    if cached and cached[1] > time.time(): return cached[0]
    HOSTNAMES[ip] = (cached[0] if cached else ip, time.time() + 600)  # не дёргаем сеть повторно, пока идёт поиск
    def work():
        name = lookup_host(ip)
        HOSTNAMES[ip] = (name, time.time() + 3600)
        with STATE_LOCK:
            for s in SESSIONS.values():
                if s["ip"] == ip: s["host"] = name
        if name != ip: execute("UPDATE devices SET host=? WHERE ip=? AND (host IS NULL OR host=ip OR host='')", (name, ip))
    threading.Thread(target=work, daemon=True).start()
    return HOSTNAMES[ip][0]

# ---------- Кто обращается ----------
def client_id():
    cid = request.cookies.get("cid", "")
    if not re.fullmatch(r"[0-9a-f]{32}", cid or ""):
        if "new_cid" not in g: g.new_cid = uuid.uuid4().hex
        cid = g.new_cid
    return cid

def current_client():
    ip = request.remote_addr or "?"
    cid = client_id()
    s = SESSIONS.get(cid)
    if s: return {"ip": ip, "host": s["host"], "user": s["user"], "client_id": cid}
    dev = query_one("SELECT user, host FROM devices WHERE client_id=?", (cid,))
    return {"ip": ip, "host": resolve_host(ip), "user": (dev or {}).get("user") or "—", "client_id": cid}

def log_event(action, path="", doc_name="", details="", client=None):
    c = client or current_client()
    try:
        execute("INSERT INTO events(ts,ip,host,user,client_id,action,path,doc_name,details) VALUES(?,?,?,?,?,?,?,?,?)",
                (now_str(), c["ip"], c["host"], c["user"], c["client_id"], action, path, doc_name, str(details)[:500]))
    except Exception as e:
        print("Ошибка записи журнала:", e)

# ---------- Сессии и устройства ----------
def active_sessions():
    limit = time.time() - ACTIVE_SECONDS
    with STATE_LOCK: return [s for s in SESSIONS.values() if s["last_seen"] >= limit]

DEVICE_LOCK = threading.Lock()

def touch_device(cid, ip, host, user, info):
    # Несколько вкладок одного браузера шлют пульс одновременно: чтение и запись карточки идут под одной блокировкой.
    with DEVICE_LOCK: _touch_device(cid, ip, host, user, info)

def _touch_device(cid, ip, host, user, info):
    now = now_str()
    dev = query_one("SELECT names, visits FROM devices WHERE client_id=?", (cid,))
    names = json.loads(dev["names"]) if dev and dev["names"] else []
    if user and user not in names: names.append(user)
    if dev:
        keep = lambda col: f"{col}=CASE WHEN ? IN ('', '?') THEN {col} ELSE ? END"  # пустые значения не затирают известные
        execute(f"UPDATE devices SET user=CASE WHEN ?='' THEN user ELSE ? END, ip=?, host=?, {keep('os')}, {keep('browser')}, {keep('screen')}, {keep('lang')}, {keep('tz')}, last_seen=?, names=?, visits=visits+? WHERE client_id=?",
                (user, user, ip, host, info["os"], info["os"], info["browser"], info["browser"], info["screen"], info["screen"], info["lang"], info["lang"], info["tz"], info["tz"],
                 now, json.dumps(names, ensure_ascii=False), info["visit"], cid))
    else:
        execute("INSERT OR IGNORE INTO devices(client_id,user,ip,host,os,browser,screen,lang,tz,first_seen,last_seen,visits,names) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)",
                (cid, user, ip, host, info["os"], info["browser"], info["screen"], info["lang"], info["tz"], now, now, json.dumps(names, ensure_ascii=False)))

def parse_ua(ua):
    os_name = "Windows" if "Windows" in ua else "macOS" if "Mac OS" in ua else "Android" if "Android" in ua else "iOS" if "iPhone" in ua or "iPad" in ua else "Linux" if "Linux" in ua else "?"
    for key, name in (("Edg/", "Edge"), ("YaBrowser/", "Yandex"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")):
        m = re.search(re.escape(key) + r"(\d+)", ua)
        if m: return os_name, f"{name} {m.group(1)}"
    return os_name, ua[:40]

def hello(data):
    """Пульс от браузера сотрудника раз в 20 с: обновляет активную сессию и карточку устройства."""
    cid = client_id()
    user = re.sub(r"\s+", " ", str(data.get("user") or "")).strip()[:80]
    ip = request.remote_addr or "?"
    now = time.time()
    ua_os, ua_browser = parse_ua(request.headers.get("User-Agent", ""))
    info = {"os": str(data.get("os") or ua_os)[:60], "browser": str(data.get("browser") or ua_browser)[:60],
            "screen": str(data.get("screen") or "")[:20], "lang": str(data.get("lang") or "")[:20], "tz": str(data.get("tz") or "")[:40]}
    with STATE_LOCK:
        s = SESSIONS.get(cid)
        fresh = s is None or not s.get("online") or s["last_seen"] < now - ACTIVE_SECONDS
        if s is None: s = SESSIONS[cid] = {"client_id": cid, "first_seen": now}
        if not user: user = s.get("user") or ""
        renamed = bool(s.get("user")) and s.get("user") != user
        host = s.get("host") if s.get("ip") == ip and s.get("host") else resolve_host(ip)
        s.update(ip=ip, host=host, user=user or "—", last_seen=now, online=True, doc=str(data.get("doc") or "")[:300], **info)
        if fresh: s["since"] = now
    info["visit"] = 1 if fresh else 0
    touch_device(cid, ip, host, user, info)
    client = {"ip": ip, "host": host, "user": user or "—", "client_id": cid}
    if fresh:
        log_event("connect", details=f"{info['os']} · {info['browser']}", client=client)
        print(f"[+] {now_hm()} подключился {user or '—'} ({host}, {ip}). Активных: {len(active_sessions())}")
    elif renamed:
        log_event("rename", details=user, client=client)
    return client

def bye():
    with STATE_LOCK:
        s = SESSIONS.get(client_id())
        if s: s["last_seen"] = time.time() - ACTIVE_SECONDS + 5  # 5 с на случай простой перезагрузки страницы

def reaper():
    while True:
        time.sleep(15)
        limit = time.time() - ACTIVE_SECONDS
        with STATE_LOCK:
            for cid, s in list(SESSIONS.items()):
                if s["last_seen"] < limit and s.get("online"):
                    s["online"] = False
                    print(f"[-] {now_hm()} отключился {s['user']} ({s['host']}, {s['ip']}). Активных: {len(active_sessions())}")
                if s["last_seen"] < time.time() - 86400: SESSIONS.pop(cid, None)
        refresh_blocks()

# ---------- Блокировки: совпадение любого из признаков (IP, имя ПК, браузер) ----------
def refresh_blocks():
    now = now_str()
    rows = query("SELECT * FROM blocks WHERE active=1")
    for r in rows:
        if r["until"] and r["until"] < now:
            execute("UPDATE blocks SET active=0, removed_at=? WHERE id=?", (now, r["id"]))
    with STATE_LOCK:
        BLOCKS[:] = [r for r in rows if not (r["until"] and r["until"] < now)]

def find_block(ip, host, cid):
    if ip in LOOPBACK: return None  # сервер никогда не блокируется, иначе можно запереть самого себя
    host_cf = (host or "").casefold()
    with STATE_LOCK:
        for b in BLOCKS:
            if (b["ip"] and b["ip"] == ip) or (b["client_id"] and b["client_id"] == cid) or (b["host"] and host_cf and b["host"].casefold() == host_cf and host_cf != ip):
                return b
    return None

_last_block_log = {}
def check_blocked():
    ip = request.remote_addr or "?"
    if not BLOCKS or ip in LOOPBACK: return None
    cid = client_id()
    s = SESSIONS.get(cid)
    host = s["host"] if s else resolve_host(ip)
    b = find_block(ip, host, cid)
    if b and time.time() - _last_block_log.get(ip, 0) > 60:
        _last_block_log[ip] = time.time()
        log_event("blocked_attempt", details=b.get("reason") or "", client={"ip": ip, "host": host, "user": (s or {}).get("user") or b.get("user") or "—", "client_id": cid})
    return b
