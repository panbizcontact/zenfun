"""Wikipedia 古墳収集 bot（雛形）

日本語版 Wikipedia のカテゴリ「日本の古墳」以下を辿り、古墳記事を収集して
ZENFUN のデータベースへ投入する。

【重要・運用上の注意】
- Wikipedia API 利用規約に従い、必ず連絡先入りの User-Agent を設定すること。
- レート制限を守り、短時間の大量アクセスは避ける（本 bot は既定で 1 秒間隔）。
- 本文・座標は CC BY-SA。ZENFUN 側で出典（source_url）を必ず保持・表示する。
- 形状・墳丘長の自動抽出は完全ではない。取り込み後の人手確認を前提とする。

使い方（プロジェクトルートで、venv 有効化後）:
    python -m bot.wikipedia_kofun_bot --max 50          # 試験的に50件
    python -m bot.wikipedia_kofun_bot --category "大阪府の古墳"
    python -m bot.wikipedia_kofun_bot --dry-run          # DBに入れず表示のみ
"""
import argparse
import re
import time
import sys

import requests

API = "https://ja.wikipedia.org/w/api.php"
# ↓連絡先を必ず自分のものに変更してください
USER_AGENT = "ZENFUN-KofunBot/0.1 (https://github.com/panbizcontact/zenfun; contact@example.com)"
HEADERS = {"User-Agent": USER_AGENT}

SHAPE_PATTERNS = [
    ("zenpokohofun", ["前方後方墳"]),
    ("zenpokoenfun", ["前方後円墳"]),
    ("hotategai", ["帆立貝", "帆立貝形", "帆立貝式", "造出付円墳"]),
    ("hofun", ["方墳"]),
    ("enpun", ["円墳"]),
]

PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県",
    "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県",
    "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県",
    "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]


def api_get(params, sleep=1.0, max_retries=5):
    params = {**params, "format": "json", "formatversion": "2"}
    for attempt in range(max_retries):
        r = requests.get(API, params=params, headers=HEADERS, timeout=30)
        if r.status_code == 429:
            wait = float(r.headers.get("retry-after", 10))
            print(f"  … レート制限(429)。{wait:.0f}秒待機して再試行します"
                  f"（{attempt + 1}/{max_retries}）", file=sys.stderr)
            time.sleep(wait)
            continue
        r.raise_for_status()
        time.sleep(sleep)  # レート制限の順守
        return r.json()
    raise requests.exceptions.HTTPError(f"429 が {max_retries} 回続いたため中断します。")


def iter_category_members(category, limit=None):
    """カテゴリ内の記事タイトルを列挙（サブカテゴリは1階層辿る）。"""
    seen, yielded = set(), 0
    queue = [category]
    while queue:
        cat = queue.pop(0)
        cont = {}
        while True:
            data = api_get({
                "action": "query", "list": "categorymembers",
                "cmtitle": "Category:" + cat, "cmlimit": "200",
                "cmtype": "page|subcat", **cont,
            })
            for m in data.get("query", {}).get("categorymembers", []):
                title = m["title"]
                if title.startswith("Category:"):
                    sub = title.split(":", 1)[1]
                    if sub not in seen:
                        seen.add(sub)
                        queue.append(sub)
                elif title not in seen:
                    seen.add(title)
                    yield title
                    yielded += 1
                    if limit and yielded >= limit:
                        return
            if "continue" in data:
                cont = data["continue"]
            else:
                break


def fetch_page(title):
    """記事のプレーンテキスト抽出＋座標を取得。"""
    data = api_get({
        "action": "query", "prop": "extracts|coordinates|info",
        "titles": title, "explaintext": "1", "exintro": "0",
        "inprop": "url",
    })
    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return None
    p = pages[0]
    coords = p.get("coordinates", [{}])
    lat = coords[0].get("lat") if coords else None
    lon = coords[0].get("lon") if coords else None
    return {
        "title": title,
        "text": p.get("extract", ""),
        "lat": lat, "lon": lon,
        "url": p.get("fullurl", "https://ja.wikipedia.org/wiki/" + title),
    }


def guess_shape(text):
    for key, words in SHAPE_PATTERNS:
        if any(w in text for w in words):
            return key
    return "unknown"


def guess_length(text):
    """「墳丘長 100メートル」「全長約120m」等から数値を推定。"""
    for pat in [r"墳丘長[^0-9]{0,6}(\d{1,3}(?:\.\d+)?)",
                r"全長[^0-9]{0,6}(?:約)?(\d{1,3}(?:\.\d+)?)\s*(?:メートル|m|ｍ)",
                r"(?:直径)[^0-9]{0,6}(?:約)?(\d{1,3}(?:\.\d+)?)\s*(?:メートル|m|ｍ)"]:
        m = re.search(pat, text)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass
    return None


def guess_prefecture(text):
    for pref in PREFECTURES:
        if pref in text:
            return pref
    return None


def is_kofun_article(title, text):
    """古墳記事らしさの簡易判定（一覧・カテゴリ等を除外）。"""
    if any(x in title for x in ["一覧", "Category", "Template", "古墳群"]):
        # 古墳群は代表点として取り込みたい場合もあるが、既定は除外
        return title.endswith("古墳")
    return "古墳" in title or "古墳" in text[:200]


def parse_article(page):
    text = page["text"]
    return {
        "name": page["title"],
        "latitude": page["lat"],
        "longitude": page["lon"],
        "shape": guess_shape(text),
        "length_m": guess_length(text),
        "prefecture": guess_prefecture(text),
        "description": text[:600].strip(),
        "source_url": page["url"],
        "data_source": "wikipedia",
    }


def upsert(record, dry_run=False):
    """ZENFUN の承認待ちキューに投入する（Kofun への直接反映はしない）。
    形状・墳丘長の自動抽出は不完全なため、管理者が /admin/review で確認・承認するまで
    地図には反映されない（bot精度対策・荒らし対策の両方を兼ねる）。
    既存（同名）の古墳・投稿済みの同名提案があれば衝突回避のためスキップする。"""
    if dry_run:
        print(f"  [dry-run] {record['name']}  "
              f"shape={record['shape']} len={record['length_m']} "
              f"pref={record['prefecture']} coord=({record['latitude']},{record['longitude']})")
        return "dry"

    import json as _json

    # 遅延インポート（bot 単体実行時にアプリ設定を読む）
    from app import create_app
    from app.extensions import db
    from app.models import Kofun, PendingChange

    app = create_app()
    with app.app_context():
        exists = Kofun.query.filter_by(name=record["name"]).first()
        if exists:
            return "skip"
        if record["latitude"] is None or record["longitude"] is None:
            return "no-coord"  # 座標なしはスキップ（地図に置けない）

        pending = PendingChange.query.filter_by(
            status="pending", action="create", data_source="wikipedia",
        ).all()
        if any(_json.loads(p.payload).get("name") == record["name"] for p in pending if p.payload):
            return "skip"

        pc = PendingChange(
            action="create", data_source="wikipedia", status="pending",
            payload=_json.dumps(record, ensure_ascii=False),
        )
        db.session.add(pc)
        db.session.commit()
        return "queued"


def run(category="日本の古墳", max_items=None, dry_run=False, sleep=1.0):
    print(f"■ カテゴリ「{category}」を収集開始"
          f"{'（DRY-RUN）' if dry_run else ''}")
    stats = {"queued": 0, "skip": 0, "no-coord": 0, "not-kofun": 0, "dry": 0, "error": 0}
    count = 0
    for title in iter_category_members(category, limit=max_items):
        count += 1
        try:
            page = fetch_page(title)
            if not page or not is_kofun_article(title, page["text"]):
                stats["not-kofun"] += 1
                continue
            record = parse_article(page)
            result = upsert(record, dry_run=dry_run)
            stats[result] = stats.get(result, 0) + 1
        except requests.HTTPError as e:
            print(f"  ! HTTP エラー: {title}: {e}", file=sys.stderr)
            stats["error"] += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ! 例外: {title}: {e}", file=sys.stderr)
            stats["error"] += 1
    print(f"■ 完了: 走査 {count} 件  → {stats}")
    return stats


def main():
    ap = argparse.ArgumentParser(description="Wikipedia 古墳収集 bot")
    ap.add_argument("--category", default="日本の古墳", help="起点カテゴリ名（Category:は不要）")
    ap.add_argument("--max", type=int, default=None, help="最大取得件数")
    ap.add_argument("--dry-run", action="store_true", help="DBに入れず表示のみ")
    ap.add_argument("--sleep", type=float, default=1.0, help="API 間隔秒")
    args = ap.parse_args()
    run(category=args.category, max_items=args.max, dry_run=args.dry_run, sleep=args.sleep)


if __name__ == "__main__":
    main()
