"""PostgreSQL + PostGIS 用のセットアップ。

DATABASE_URL が PostgreSQL を指している場合に一度だけ実行する。
- postgis 拡張を有効化
- kofun.geom (geography(Point,4326)) 列を追加し、既存の緯度経度から生成
- GiST 空間インデックスを作成（バウンディングボックス検索を高速化）
- INSERT/UPDATE のたびに geom を緯度経度から自動更新するトリガーを設定

使い方（先に `python run.py` などで db.create_all() によりテーブルを作成しておくこと）:
    DATABASE_URL=postgresql://user:pass@localhost/zenfun python -m scripts.setup_postgis
"""
from app import create_app
from app.extensions import db
from app.postgis import ensure_postgis

# 注意: アプリは起動時(create_app)にも自動でこのセットアップを試みる（失敗時は
# 緯度経度検索にフォールバックし、起動は止めない）。このスクリプトは手動で結果を
# 確認したい場合や、起動ログを追いにくい環境向けの手段として残している。


def main():
    app = create_app()
    with app.app_context():
        if db.engine.dialect.name != "postgresql":
            print("DATABASE_URL が PostgreSQL ではありません。処理を中止します。"
                  f"（現在: {db.engine.dialect.name}）")
            return
        if ensure_postgis(db):
            print("PostGIS のセットアップが完了しました（geom列・GiST索引・同期トリガー）。")
        else:
            print("PostGIS のセットアップに失敗しました（postgis 拡張が使えない環境の可能性）。"
                  "緯度経度による範囲検索にフォールバックします。")


if __name__ == "__main__":
    main()
