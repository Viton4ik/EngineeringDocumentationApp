from __future__ import annotations
from datetime import timedelta
from flask import Flask, request, g, jsonify, render_template
from .config import BASE, HOST, UPLOAD_MAX_MB, SHARE_NAME, VERSION
from .db import init_db
from .auth import secret_key, is_admin
from .clients import check_blocked, refresh_blocks, client_id
from .i18n import t, js_strings, LANGS, LANG_NAMES, current_lang

EXEMPT_FROM_BLOCK = ("/admin", "/api/admin", "/static", "/lang")

def create_app():
    init_db()
    app = Flask(__name__, template_folder=str(BASE / "templates"), static_folder=str(BASE / "static"))
    app.config.update(SECRET_KEY=secret_key(), MAX_CONTENT_LENGTH=UPLOAD_MAX_MB * 1024 * 1024 + 2 * 1024 * 1024,
                      PERMANENT_SESSION_LIFETIME=timedelta(days=7), SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_NAME="portal_admin")
    refresh_blocks()

    @app.before_request
    def guard():
        g.lang = current_lang()
        client_id()  # cookie браузера выдаётся с первой же страницы
        # Простая защита от подделки запросов: браузер не даст чужому сайту поставить этот заголовок без CORS.
        if request.method == "POST" and request.path.startswith("/api/") and request.path != "/api/bye" and request.headers.get("X-Portal") != "1":
            return jsonify({"error": "bad request"}), 400
        if request.path.startswith(EXEMPT_FROM_BLOCK): return None
        b = check_blocked()
        if b:
            if request.path.startswith("/api/"): return jsonify({"blocked": True, "error": t("blocked_title"), "reason": b.get("reason") or ""}), 403
            return render_template("blocked.html", block=b, host=HOST), 403

    @app.after_request
    def set_cookie(resp):
        if "new_cid" in g:
            resp.set_cookie("cid", g.new_cid, max_age=5 * 365 * 86400, samesite="Lax", httponly=True)
        return resp

    @app.context_processor
    def inject():
        return dict(t=t, lang=g.get("lang", "ru"), langs=LANGS, lang_names=LANG_NAMES, js_i18n=js_strings(), version=VERSION,
                    portal_cfg={"share": SHARE_NAME, "host": HOST, "version": VERSION})

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(413)
    def readable_error(e):
        msg = t("err_too_large", mb=UPLOAD_MAX_MB) if e.code == 413 else (e.description if e.code == 409 else t(f"err_{e.code}"))
        if request.path.startswith("/api/"): return jsonify({"error": msg}), e.code
        return render_template("error.html", message=msg, code=e.code, host=HOST), e.code

    from .routes_public import bp as public_bp
    from .routes_admin import bp as admin_bp
    app.register_blueprint(public_bp)
    app.register_blueprint(admin_bp)
    return app
