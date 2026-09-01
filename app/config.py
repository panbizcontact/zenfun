"""アプリケーション設定。環境変数から読み込む。"""
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-insecure-change-me")

    # 既定は data/zenfun.db の SQLite。DATABASE_URL で上書き可能。
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        "sqlite:///" + os.path.join(BASE_DIR, "data", "zenfun.db"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    ALLOW_REGISTRATION = os.environ.get("ALLOW_REGISTRATION", "true").lower() == "true"

    # レート制限の保存先。既定はプロセス内メモリ。本番/複数プロセスでは Redis 等に変更する。
    RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
