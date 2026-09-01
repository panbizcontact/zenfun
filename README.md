# 全墳 ZENFUN — 全国古墳マップ

国土地理院の陰影図の上に、全国の古墳を形状別マークで表示する共同編集マップです。
Flask + MapLibre GL JS + SQLite（→ PostgreSQL/PostGIS）。

## できること（この土台の実装範囲）

- 国土地理院タイル（陰影起伏図＋淡色地図）で地形・道路・海を表現
- ズームに応じた規模フィルタ（縮小時は大型古墳のみ表示）
- 形状別マーク（前方後円墳・帆立貝式・円墳・方墳・前方後方墳）＋主軸方位で回転
- 表示件数が多いとき（既定 400 件超）は MapLibre のネイティブクラスタリングに自動切替
- 古墳クリックで詳細情報パネル、編集履歴の閲覧
- 左上の検索ボックス（都道府県・形状・年代・墳丘長で絞り込み＋リスト表示）
- 会員登録制の共同編集。**管理者以外の追加・編集・削除は承認待ちキューに入り、
  管理者が `/admin/review` で承認するまで地図に反映されない**（荒らし対策）
- 管理者は編集履歴から任意の版へ「差し戻し」が可能
- 書き込み系 API・登録・ログインにレート制限（Flask-Limiter）
- Wikipedia 古墳収集 bot。取り込みは承認待ちキューに入り、bot の抽出精度に頼らず
  管理者が確認してから反映される
- PostgreSQL + PostGIS への移行スクリプト（`scripts/migrate_to_postgres.py` /
  `scripts/setup_postgis.py`）。移行後は地図のバウンディングボックス検索が
  GiST 空間索引を使う経路に自動的に切り替わる

## セットアップ

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # SECRET_KEY を必ず書き換える
python -m scripts.seed_data        # サンプル古墳を投入（任意）
python run.py                      # http://127.0.0.1:5000
```

最初に会員登録したユーザーが自動的に管理者になります。

## Wikipedia 収集 bot

```bash
python -m bot.wikipedia_kofun_bot --max 50 --dry-run   # まず表示だけで確認
python -m bot.wikipedia_kofun_bot --category "大阪府の古墳"
```

**注意**: `bot/wikipedia_kofun_bot.py` の `USER_AGENT` の連絡先を自分のものに変更してください。
Wikipedia 由来のデータは CC BY-SA です。`source_url`（出典）を必ず保持・表示します。
形状・墳丘長の自動抽出は不完全なので、bot の投稿は承認待ちキューに入り、
`/admin/review` で管理者が確認・修正してから承認するまで地図には反映されません。

## 承認レビュー（荒らし対策・bot精度対策）

- 管理者（`is_admin=True`。最初に会員登録したユーザーが自動的に管理者）以外の
  追加・編集・削除は即時反映されず、`PendingChange` テーブル（承認待ちキュー）に入ります。
- 管理者は `/admin/review` で提案内容を確認し、承認／却下（理由つき）できます。
- 承認された変更は通常どおり `EditHistory` に記録されるため、承認後も差し戻せます。
- 古墳の詳細パネルの「編集履歴を見る」から、管理者は任意の版へ差し戻せます
  （`POST /api/kofun/<id>/history/<hist_id>/revert`）。
- 書き込み系 API（追加・編集・削除）・会員登録・ログインには
  Flask-Limiter によるレート制限がかかっています（既定: 書き込み30回/時、登録10回/時、
  ログイン20回/時。`app/routers/kofun.py` の `WRITE_RATE_LIMIT` 等で調整可能）。
  保存先は既定でプロセス内メモリ（`memory://`）。本番・複数プロセス構成では
  `.env` の `RATELIMIT_STORAGE_URI` を Redis 等に変更してください。

## PostgreSQL/PostGIS への移行

既定は SQLite（`data/zenfun.db`）ですが、全国数千基規模になったら PostgreSQL + PostGIS へ移行できます。

```bash
# 1) PostgreSQL 側にテーブルを作成（一度起動して Ctrl+C でよい）
DATABASE_URL=postgresql://user:pass@localhost/zenfun python run.py

# 2) SQLite の既存データをコピー
DATABASE_URL=postgresql://user:pass@localhost/zenfun python -m scripts.migrate_to_postgres

# 3) PostGIS 拡張・geom列・GiST索引・同期トリガーをセットアップ
DATABASE_URL=postgresql://user:pass@localhost/zenfun python -m scripts.setup_postgis

# 4) .env の DATABASE_URL を上記に切り替えて起動
```

移行後は `/api/kofun` の地図バウンディングボックス検索が自動的に
`geom && ST_MakeEnvelope(...)`（GiST索引）を使う経路に切り替わります
（`app/routers/kofun.py` の `_apply_bbox_filter`、接続先の dialect で自動判定）。
`kofun.geom` は緯度経度の変更のたびにトリガーで自動更新されるため、
アプリ側のコードは緯度経度を書き込むだけで意識する必要はありません。

## 大量データ時のクラスタ表示

地図の表示範囲内の件数が `CLUSTER_THRESHOLD`（既定 400、`app/static/js/map.js`）を超えると、
形状アイコンの個別マーカーではなく MapLibre GL のネイティブクラスタリング（円＋件数集約）に
自動的に切り替わります。ズームすると `getClusterExpansionZoom` で該当クラスタまで寄ります。
全国数千基を投入してもブラウザの描画負荷が線形に増えないための仕組みです。

## 構成

```
zenfun/
├── run.py                 起動
├── app/
│   ├── __init__.py        アプリファクトリ
│   ├── config.py          設定・ズーム閾値・レート制限保存先
│   ├── extensions.py      db / login_manager / limiter
│   ├── models.py          User / Kofun / EditHistory / PendingChange
│   ├── routers/           main / auth / kofun(API) / admin(承認レビュー・差し戻し)
│   ├── templates/         index / login / register / admin_review
│   └── static/            css・js（markers.js が形状SVGを生成、map.js がクラスタ表示も担当）
├── bot/wikipedia_kofun_bot.py   承認待ちキューへ投入
├── scripts/
│   ├── seed_data.py
│   ├── migrate_to_postgres.py  SQLite → PostgreSQL データ移行
│   └── setup_postgis.py        PostGIS 拡張・geom列・索引・トリガー設定
└── data/zenfun.db         SQLite（自動生成）
```

## 次の拡張候補

- ベクタータイル配信（現状はクラスタリングのみ。数万基規模ではタイル化も検討）
- 承認キューの通知（メール等）や複数管理者向けの担当割り当て
- 既存 ZENFUN の 3D 表示（Three.js）との統合
