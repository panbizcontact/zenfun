"""起動時に、モデルに後から足した列がデータベースにもあることを確かめる。

このアプリはマイグレーションツールを使わず db.create_all() でテーブルを作る。
create_all() は「無いテーブル」は作るが「無い列」は足さないため、既に運用中の
データベース（本番の PostgreSQL など）に列を追加したときはここで補う。

いずれも NULL 許容の列として足すので、既存の行はそのまま使える。
"""
import logging

from sqlalchemy import inspect, text

logger = logging.getLogger(__name__)

# テーブル名 -> [(列名, 型のDDL), ...]
ADDED_COLUMNS = {
    "kofun": [
        ("length_is_estimated", "BOOLEAN"),
        ("height_is_estimated", "BOOLEAN"),
    ],
}


def ensure_columns(db) -> None:
    inspector = inspect(db.engine)
    for table, columns in ADDED_COLUMNS.items():
        if not inspector.has_table(table):
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for name, ddl in columns:
            if name in existing:
                continue
            try:
                db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                db.session.commit()
                logger.info("%s に列 %s を追加しました。", table, name)
            except Exception:
                db.session.rollback()
                logger.warning("%s への列 %s の追加に失敗しました。", table, name, exc_info=True)
