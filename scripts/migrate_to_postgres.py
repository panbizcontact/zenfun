"""SQLite (data/zenfun.db) の内容を PostgreSQL(DATABASE_URL) へコピーする。

手順:
    1. PostgreSQL 側で一度 `DATABASE_URL=postgresql://... python run.py` を起動し、
       db.create_all() でテーブルを作成する（Ctrl+C で止めてよい）。
    2. python -m scripts.migrate_to_postgres
    3. python -m scripts.setup_postgis   # PostGIS の geom列・索引・トリガーを設定
"""
import os
import sys

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
SQLITE_URL = "sqlite:///" + os.path.join(BASE_DIR, "data", "zenfun.db")

# 依存順（外部キーの参照先が先）
from app.models import User, Kofun, EditHistory, PendingChange  # noqa: E402

MODELS = (User, Kofun, EditHistory, PendingChange)


def main():
    pg_url = os.environ.get("DATABASE_URL")
    if not pg_url or not pg_url.startswith("postgres"):
        print("環境変数 DATABASE_URL に PostgreSQL の接続文字列を設定してください。")
        print('例: DATABASE_URL=postgresql://user:pass@localhost/zenfun python -m scripts.migrate_to_postgres')
        sys.exit(1)

    src_session = sessionmaker(bind=create_engine(SQLITE_URL))()
    dst_session = sessionmaker(bind=create_engine(pg_url))()

    for Model in MODELS:
        rows = src_session.query(Model).all()
        print(f"{Model.__tablename__}: {len(rows)} 件を移行します…")
        for row in rows:
            data = {c.name: getattr(row, c.name) for c in Model.__table__.columns}
            dst_session.merge(Model(**data))
        dst_session.commit()

    print("移行が完了しました。次に `python -m scripts.setup_postgis` を実行してください。")


if __name__ == "__main__":
    main()
