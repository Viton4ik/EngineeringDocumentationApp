"""GASTRANS Engineering Documentation: точка входа.
   python app.py                          - запуск сервера (при первом запуске спросит пароль admin)
   python app.py --reset-admin-password   - задать новый пароль admin (только на сервере)"""
from __future__ import annotations
import sys, socket, getpass, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))  # пакет portal рядом с app.py при любом способе запуска
from portal.config import PORT, HOST, DOC_SHARE, SOFFICE, FFMPEG, DEFENDER, Image, ADMIN_MIN_PASSWORD
from portal.db import init_db
from portal import auth

def ask_password():
    while True:
        first = getpass.getpass(f"Новый пароль для admin (минимум {ADMIN_MIN_PASSWORD} символов): ")
        if len(first) < ADMIN_MIN_PASSWORD:
            print("Слишком короткий пароль."); continue
        if getpass.getpass("Повторите пароль: ") != first:
            print("Пароли не совпадают."); continue
        auth.set_admin_password(first)
        print("Пароль администратора сохранён. Учётная запись: admin")
        return

def lan_addresses():
    try: return sorted({i[4][0] for i in socket.getaddrinfo(HOST, None, socket.AF_INET) if not i[4][0].startswith("127.")})
    except OSError: return []

def main():
    init_db()
    if "--reset-admin-password" in sys.argv or "--set-admin-password" in sys.argv:
        ask_password(); return
    if not auth.has_admin_password():
        print("=" * 60 + "\nПервый запуск: создайте пароль администратора (учётная запись admin).\n" + "=" * 60)
        if sys.stdin and sys.stdin.isatty():
            ask_password()
        else:
            print("Консоль недоступна. Админ-панель отключена, пока не выполните: python app.py --reset-admin-password")
    from portal import create_app
    from portal.catalog import scan_documents
    from portal.clients import reaper
    app = create_app()
    print("Сканирование каталога…")
    files, err = scan_documents()
    print(err or f"Найдено файлов: {len(files)}")
    print(f"LibreOffice: {SOFFICE or 'нет'} | ffmpeg: {FFMPEG or 'нет'} | Pillow: {'да' if Image else 'нет'} | Defender: {DEFENDER or 'нет'}")
    admin_share = "\\\\" + HOST + "\\C$"
    print("Сетевая папка (DOC_SHARE):", DOC_SHARE or f"не задана, пути строятся через {admin_share} (нужны права администратора)")
    print(f"Каталог: http://{HOST}:{PORT}   " + "   ".join(f"http://{ip}:{PORT}" for ip in lan_addresses()))
    print(f"Админ-панель (с любого ПК в сети, логин admin): http://{HOST}:{PORT}/admin")
    print("Остановка сервера: Ctrl+C или закройте это окно.")
    threading.Thread(target=reaper, daemon=True).start()
    try:
        from waitress import serve
        serve(app, host="0.0.0.0", port=PORT, threads=16, max_request_body_size=app.config["MAX_CONTENT_LENGTH"], channel_timeout=300, ident="GASTRANS-Docs")
    except ImportError:
        app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)

if __name__ == "__main__":
    main()
