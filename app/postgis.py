"""PostgreSQL + PostGIS の自動セットアップ（フェイルセーフ）。

PostgreSQL 接続時にアプリ起動時から自動的に geom 列・GiST索引・同期トリガーを用意する。
postgis 拡張が使えないホスティング環境（無料プランなど）でも、ここで失敗させず
plain な緯度経度フィルタにフォールバックできるよう、成功可否を呼び出し元に返す。
"""
import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

SQL = """
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE kofun ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);

UPDATE kofun SET geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE geom IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_kofun_geom ON kofun USING GIST (geom);

CREATE OR REPLACE FUNCTION kofun_sync_geom() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kofun_sync_geom ON kofun;
CREATE TRIGGER trg_kofun_sync_geom
  BEFORE INSERT OR UPDATE OF latitude, longitude ON kofun
  FOR EACH ROW EXECUTE FUNCTION kofun_sync_geom();
"""


def ensure_postgis(db) -> bool:
    """PostgreSQL 接続時のみ実行。成功すれば True（以後 GiST 索引によるbbox検索が使える）、
    postgis 拡張が使えない等で失敗した場合は False を返し、呼び出し元は緯度経度の
    範囲検索にフォールバックする（アプリの起動自体は止めない）。"""
    if db.engine.dialect.name != "postgresql":
        return False
    try:
        with db.engine.begin() as conn:
            conn.execute(text(SQL))
        return True
    except Exception:  # noqa: BLE001 — 拡張未対応など環境依存の失敗を握りつぶしてフォールバック
        logger.warning(
            "PostGIS のセットアップに失敗したため、緯度経度による範囲検索にフォールバックします。",
            exc_info=True,
        )
        return False
