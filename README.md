# 全墳 ZENFUN — 全国古墳マップ

国土地理院の陰影図の上に、全国の古墳を表示する共同編集マップです。
Flask + MapLibre GL JS + SQLite（→ PostgreSQL/PostGIS）。

## できること（この土台の実装範囲）

- 国土地理院タイル（陰影起伏図＋淡色地図）で地形・道路・海を表現。画面中央には
  地理院地図と同様の十字マークを表示
- ズーム1〜10は透明度のある丸で古墳の位置を表現。ズーム11以上では、輪郭が
  登録済みの古墳は実際の輪郭Pathで、未登録のものは引き続き丸で表示
- 会員は地図上で古墳の輪郭（墳丘・周堤・単純な線）を描いて登録できる編集画面を搭載。
  周堤は複数（二重・三重の周濠）や外側/内側どちらか片方だけの輪にも対応
- 検索バーは入力に応じて古墳名の候補を文字のみで表示（選ぶとその古墳へ移動）
- 古墳をクリックすると、画面中央に論文体裁の詳細を表示
- 編集画面は論文の記入用紙を模した体裁。所在地（都道府県・市区町村）は
  緯度経度から国土地理院の逆ジオコーダーで自動判定される
- 白と赤（辰砂）を基調とした意匠
- 会員登録制の共同編集。**管理者以外の追加・編集・削除は承認待ちキューに入り、
  管理者が `/admin/review` で承認するまで地図に反映されない**（荒らし対策）
- 管理者は編集履歴から任意の版へ「差し戻し」が可能
- 書き込み系 API・登録・ログインにレート制限（Flask-Limiter）
- Wikipedia 古墳収集 bot。取り込みは承認待ちキューに入り、bot の抽出精度に頼らず
  管理者が確認してから反映される
- PostgreSQL + PostGIS への移行スクリプト（`scripts/migrate_to_postgres.py` /
  `scripts/setup_postgis.py`）。postgis 拡張が使える環境ではアプリ起動時に自動で
  GiST 空間索引が有効化され、使えない環境では緯度経度検索にフォールバックする

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
- 古墳の詳細画面の「履歴を表示する」から、管理者は任意の版へ差し戻せます
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

移行後は `/api/kofun` の地図バウンディングボックス検索が `geom && ST_MakeEnvelope(...)`
（GiST索引）を使う経路に切り替わります。切り替えはアプリ起動時（`create_app`）に
`app/postgis.py` の `ensure_postgis()` が PostgreSQL 接続を検知して自動実行し、
結果を `app.config["POSTGIS_ENABLED"]` に保持します。postgis 拡張が使えない環境
（一部ホスティングの無料プラン等）では起動を止めずに緯度経度検索へフォールバックします。
`kofun.geom` は緯度経度の変更のたびにトリガーで自動更新されるため、
アプリ側のコードは緯度経度を書き込むだけで意識する必要はありません。

## 大量データ時の表示負荷対策

ズーム1〜10の丸表示は MapLibre GL のネイティブクラスタリング（GeoJSON `cluster: true`）
を使っており、件数が多い範囲では円が件数集約された大きな円にまとまります
（`app/static/js/map.js` の `setupMapLayers`）。ズーム11以上の輪郭Path表示は
バウンディングボックスで絞り込まれた範囲内のみ描画するため、全国数千基を
投入してもブラウザの描画負荷が線形に増えない設計です。

## デプロイ（Render の例）

このリポジトリには [Render](https://render.com) 用の `render.yaml`（Blueprint）を
同梱しています。Render ダッシュボードで「New +」→「Blueprint」からこの GitHub
リポジトリを選ぶと、Web サービスと無料 PostgreSQL データベースがまとめて作成され、
`DATABASE_URL` も自動で配線されます。

```bash
# 1) このリポジトリを GitHub に push しておく（Render はGitHub/GitLab連携でデプロイする）
git remote add origin <your-github-repo-url>
git push -u origin main

# 2) Render ダッシュボード → New + → Blueprint → 上記リポジトリを選択
#    render.yaml の内容がそのまま反映される（SECRET_KEY は自動生成）
```

**公開後、真っ先にやること**: このアプリは「最初に会員登録したユーザーが自動的に
管理者になる」仕様です。公開直後に自分で会員登録して管理者アカウントを確保して
から URL を共有してください。荒らし対策として一時的に登録を止めたい場合は、
Render の環境変数 `ALLOW_REGISTRATION` を `false` に変更して再デプロイします。

Render の無料 PostgreSQL は一定期間（目安90日）で期限切れになる制限があるため、
長期運用する場合は有料プランへのアップグレードを検討してください。
Render の無料 Web サービスは無操作が続くとスリープし、次のアクセス時に
数十秒の起動待ちが発生します。

## 構成

```
zenfun/
├── run.py                 起動
├── render.yaml             Render Blueprint（Webサービス＋PostgreSQL）
├── app/
│   ├── __init__.py        アプリファクトリ（起動時にPostGISセットアップも実行）
│   ├── config.py          設定・レート制限保存先
│   ├── extensions.py      db / login_manager / limiter
│   ├── postgis.py         PostGIS 自動セットアップ（フェイルセーフ）
│   ├── geocode.py         逆ジオコーディング（座標→都道府県・市区町村）
│   ├── data/muni.json     市区町村コード表（国土地理院 muni.js より生成）
│   ├── models.py          User / Kofun / EditHistory / PendingChange
│   ├── routers/           main / auth / kofun(API) / admin(承認レビュー・差し戻し)
│   ├── templates/         index / login / register / admin_review
│   └── static/            css・js（map.js が地図描画・検索候補・輪郭編集を担当）
├── bot/wikipedia_kofun_bot.py   承認待ちキューへ投入
├── scripts/
│   ├── seed_data.py
│   ├── migrate_to_postgres.py  SQLite → PostgreSQL データ移行
│   └── setup_postgis.py        PostGIS 拡張・geom列・索引・トリガー設定（手動実行用）
└── data/zenfun.db         SQLite（自動生成、既定のDB）
```

## 次の拡張候補

- ベクタータイル配信（現状はクラスタリング＋bbox絞り込みのみ。数万基規模では検討）
- 承認キューの通知（メール等）や複数管理者向けの担当割り当て
- 既存 ZENFUN の 3D 表示（Three.js）との統合
