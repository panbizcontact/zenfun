# 古墳マップ — Kofun Map Japan

日本全国の古墳を地理院地図上に表示するWebサービスです。

## セットアップ

```bash
# 依存パッケージのインストール
pip install -r requirements.txt

# サーバー起動
python app.py
```

ブラウザで http://localhost:5000 を開いてください。

---

## ディレクトリ構成

```
kofun-map/
├── app.py              # Flask アプリ本体
├── requirements.txt
├── data/
│   └── kofun.json      # 古墳データ（ここを編集して追加）
└── templates/
    └── index.html      # フロントエンド（地図・サイドバー）
```

---

## 古墳データの追加方法

`data/kofun.json` に以下の形式でオブジェクトを追加してください。

```json
{
  "id": 21,
  "name": "○○古墳",
  "yomi": "ふりがな",
  "prefecture": "○○県",
  "city": "○○市",
  "lat": 34.1234,
  "lng": 135.5678,
  "era": "古墳時代中期",
  "century": "5世紀",
  "type": "前方後円墳",
  "length_m": 150,
  "height_m": 12.5,
  "description": "説明文",
  "photo_url": "https://...",
  "world_heritage": false,
  "national_historic_site": true
}
```

**type の例:** 前方後円墳 / 前方後方墳 / 円墳 / 方墳 / 帆立貝形古墳 / 双方中円墳 / 古墳群 / 横穴墓群

**photo_url:** Wikimedia Commons などの公開画像URL、または `null`

---

## 地図レイヤー

地理院タイル（国土地理院）を使用しています。

| キー | 地図の種類 |
|------|-----------|
| std | 標準地図 |
| pale | 淡色地図 |
| relief | 陰影起伏図（地形がわかりやすい） |
| photo | 航空写真 |

---

## API エンドポイント

| エンドポイント | 説明 |
|--------------|------|
| `GET /api/kofun` | 全古墳一覧（フィルタ対応） |
| `GET /api/kofun?q=大仙` | キーワード検索 |
| `GET /api/kofun?prefecture=奈良県` | 都道府県絞り込み |
| `GET /api/kofun?world_heritage=true` | 世界遺産のみ |
| `GET /api/kofun?sort=length` | 規模順 |
| `GET /api/kofun/<id>` | 古墳の詳細 |
| `GET /api/stats` | 統計情報（都道府県一覧など） |

---

## 本番デプロイ時の注意

- `app.py` の `debug=True` を `False` に変更してください
- 大量データを扱う場合はSQLite等のDBへの移行を推奨します
- `gunicorn app:app` で起動するとより安定します
