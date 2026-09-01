"""アプリケーション設定。環境変数から読み込む。"""
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))


def _normalize_database_url(url: str) -> str:
    """Render/Heroku 等が発行する "postgres://" は SQLAlchemy 1.4+/2.0 では
    未対応(NoSuchModuleError, sqlalche.me/e/20/e3q8)。"postgresql://" に書き換える。"""
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://"):]
    return url


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-insecure-change-me")

    # 既定は data/zenfun.db の SQLite。DATABASE_URL で上書き可能。
    SQLALCHEMY_DATABASE_URI = _normalize_database_url(os.environ.get(
        "DATABASE_URL",
        "sqlite:///" + os.path.join(BASE_DIR, "data", "zenfun.db"),
    ))
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # 管理された PostgreSQL (Render等) はアイドル接続を無断で切断することがあり、
    # プールが古い接続を使い回すと "SSL error" / "server closed the connection"
    # で失敗する。pool_pre_ping で使用前に生死確認し、pool_recycle で先回りして
    # 定期的に接続を張り直す。
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
    }

    ALLOW_REGISTRATION = os.environ.get("ALLOW_REGISTRATION", "true").lower() == "true"

    # レート制限の保存先。既定はプロセス内メモリ。本番/複数プロセスでは Redis 等に変更する。
    RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
