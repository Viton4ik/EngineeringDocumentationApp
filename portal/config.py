from __future__ import annotations
import os, shutil, socket
from pathlib import Path

VERSION = "4.0"
BASE = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = Path(os.environ.get("DOC_ROOT", r"C:\Documentation")).expanduser()
SIEMENS_DIR = Path(os.environ.get("DOC_META_DIR", r"C:\Documentation_ext"))
NAME_FILE = Path(os.environ.get("SIM_NAME_FILE", str(SIEMENS_DIR / "SIM_name.txt")))
NUMBER_FILE = Path(os.environ.get("SIM_NUMBER_FILE", str(SIEMENS_DIR / "SIM_number.txt")))
# Сетевая папка, указывающая на DOC_ROOT, например \\GST-SRV\Documentation. Без неё UNC строится через админ-ресурс C$.
DOC_SHARE = os.environ.get("DOC_SHARE", "").strip().rstrip("\\/")
# Имя общей папки без сервера. Сетевой путь в браузере строится от адреса, по которому сотрудник открыл каталог:
# открыл http://10.200.15.106:8080 -> \\10.200.15.106\Documentation\..., открыл по имени ПК -> \\ИМЯ\Documentation\...
SHARE_NAME = DOC_SHARE.replace("/", "\\").split("\\")[-1] if DOC_SHARE else ""
# Разделы верхнего уровня, где название документа берётся из имени файла (без чтения первой страницы).
NAME_FROM_FILENAME = {d.strip().casefold() for d in os.environ.get("NAME_FROM_FILENAME", "Check lists").split(";") if d.strip()}
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE / "data")))
CACHE_DIR = DATA_DIR / "cache"
SUBMIT_DIR = DATA_DIR / "submissions"
DB_FILE = DATA_DIR / "portal.db"
PORT = int(os.environ.get("PORT", "8080"))
TITLE_SCAN = os.environ.get("TITLE_SCAN", "1") != "0"
UPLOAD_MAX_MB = int(os.environ.get("UPLOAD_MAX_MB", "500"))
# Файлы в каталог копирует процесс сервера своей учётной записью, поэтому одобрять можно с любого ПК. 1 = только с ПК сервера.
APPROVE_ONLY_ON_SERVER = os.environ.get("APPROVE_ONLY_ON_SERVER", "0") == "1"
ADMIN_MIN_PASSWORD = 6
ACTIVE_SECONDS = 60
HOST = socket.gethostname()
LOOPBACK = {"127.0.0.1", "::1"}
for d in (DATA_DIR, CACHE_DIR, SUBMIT_DIR, DATA_DIR / "tmp"): d.mkdir(parents=True, exist_ok=True)

def find_tool(env, names, candidates):
    if os.environ.get(env) and Path(os.environ[env]).exists(): return os.environ[env]
    for n in names:
        if shutil.which(n): return shutil.which(n)
    return next((c for c in candidates if Path(c).exists()), None)

SOFFICE = find_tool("SOFFICE", ["soffice", "libreoffice"], [r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"])
FFMPEG = find_tool("FFMPEG", ["ffmpeg"], [r"C:\ffmpeg\bin\ffmpeg.exe", r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"])
DEFENDER = find_tool("DEFENDER", [], [os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Windows Defender", "MpCmdRun.exe")])
try:
    from PIL import Image
except ImportError:
    Image = None

EXCLUDED = {".git", "$RECYCLE.BIN", "System Volume Information", "aspnet_client"}
TEXT_EXTS = {".txt", ".md", ".json", ".xml", ".log", ".ini", ".yaml", ".yml", ".py", ".css", ".js", ".cfg", ".conf", ".bat", ".cmd", ".ps1", ".sql", ".rst", ".toml", ".properties", ".tsv", ".nfo"}
HTML_EXTS = {".html", ".htm"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"}
IMAGE_CONVERT = {".tif", ".tiff", ".tga", ".pcx", ".ppm", ".psd", ".dib", ".jp2"}
VIDEO_EXTS = {".mp4", ".webm", ".ogv", ".m4v", ".mov"}
VIDEO_CONVERT = {".avi", ".mkv", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".ts", ".mts", ".m2ts", ".vob", ".asf"}
AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"}
AUDIO_CONVERT = {".wma", ".aif", ".aiff", ".amr"}
WORD_EXTS = {".doc", ".docx", ".docm", ".dot", ".dotx", ".rtf", ".odt"}
EXCEL_EXTS = {".xls", ".xlsx", ".xlsm", ".xlsb", ".ods"}
POWERPOINT_EXTS = {".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".odp"}
VISIO_EXTS = {".vsd", ".vsdx"}
OFFICE_EXTS = WORD_EXTS | EXCEL_EXTS | POWERPOINT_EXTS | VISIO_EXTS | {".odg", ".pub", ".wpd"}
# Только эти типы браузер показывает сам; всё остальное /api/raw отдаёт исключительно как явное скачивание.
INLINE_EXTS = {".pdf"} | IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS | TEXT_EXTS | HTML_EXTS | {".csv"}
EXEC_EXTS = {".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".scr", ".lnk", ".reg", ".jar", ".dll"}
DEFAULT_ALLOWED = ("pdf doc docx docm dot dotx rtf odt xls xlsx xlsm xlsb ods csv ppt pptx pptm pps ppsx odp vsd vsdx odg txt md xml json "
                   "dwg dxf dwf step stp igs iges stl jpg jpeg png gif bmp tif tiff webp svg mp4 mov avi mkv wmv mp3 wav "
                   "zip 7z rar msg eml exe msi bat cmd ps1 vbs")
ALLOWED_EXTS = {"." + e.strip().lower().lstrip(".") for e in os.environ.get("UPLOAD_EXTS", DEFAULT_ALLOWED).replace(",", " ").split() if e.strip()}

def file_kind(ext):
    for kind, exts in (("pdf", {".pdf"}), ("image", IMAGE_EXTS | IMAGE_CONVERT), ("video", VIDEO_EXTS | VIDEO_CONVERT),
                       ("audio", AUDIO_EXTS | AUDIO_CONVERT), ("word", WORD_EXTS), ("excel", EXCEL_EXTS | {".csv"}),
                       ("powerpoint", POWERPOINT_EXTS), ("visio", VISIO_EXTS), ("text", TEXT_EXTS | HTML_EXTS),
                       ("archive", {".zip", ".7z", ".rar"}), ("mail", {".eml", ".msg"}), ("cad", {".dwg", ".dxf", ".step", ".stp", ".igs"})):
        if ext in exts: return kind
    return "other"
