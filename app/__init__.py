"""アプリケーションファクトリ。"""
import os

from flask import Flask

from .config import Config
from .extensions import db, login_manager, limiter


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    # data ディレクトリを確保（SQLite ファイル置き場）
    os.makedirs(os.path.join(app.root_path, "..", "data"), exist_ok=True)

    db.init_app(app)
    login_manager.init_app(app)
    limiter.init_app(app)

    from .models import User

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    # ブループリント登録
    from .routers.main import bp as main_bp
    from .routers.auth import bp as auth_bp
    from .routers.kofun import bp as kofun_bp
    from .routers.admin import bp as admin_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(kofun_bp)
    app.register_blueprint(admin_bp)

    with app.app_context():
        db.create_all()
        from .postgis import ensure_postgis
        # PostgreSQL 接続時のみ実行。postgis 拡張が使えない環境では False が返り、
        # 起動は止めずに緯度経度による範囲検索へフォールバックする。
        app.config["POSTGIS_ENABLED"] = ensure_postgis(db)

    return app
