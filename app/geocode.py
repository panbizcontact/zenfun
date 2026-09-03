"""座標から住所（都道府県・市区町村）を求める逆ジオコーディング。

国土地理院の逆ジオコーダーが返すのは市区町村コードのみなので、
同じく国土地理院が公開している市区町村コード表（app/data/muni.json に
取り込み済み）と突き合わせて名称に変換する。

地図タイルと同じ国土地理院のサービスを使うため、出典表記も既存のものに揃う。
"""
import json
import logging
import os
from functools import lru_cache

import requests

logger = logging.getLogger(__name__)

GSI_REVERSE_GEOCODER = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress"
USER_AGENT = "ZENFUN/1.0 (https://zenfun.onrender.com)"
TIMEOUT_SEC = 8

_MUNI_PATH = os.path.join(os.path.dirname(__file__), "data", "muni.json")


@lru_cache(maxsize=1)
def _muni_table() -> dict:
    """市区町村コード → [都道府県, 市区町村] の対応表（初回のみ読み込む）。"""
    try:
        with open(_MUNI_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        logger.warning("市区町村コード表を読み込めませんでした: %s", _MUNI_PATH, exc_info=True)
        return {}


def reverse_geocode(lat: float, lng: float) -> dict:
    """緯度経度から {"prefecture": ..., "municipality": ...} を返す。
    解決できない場合（海上・国外・API不通など）は空の辞書を返し、例外は投げない。"""
    try:
        r = requests.get(
            GSI_REVERSE_GEOCODER,
            params={"lat": lat, "lon": lng},
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT_SEC,
        )
        r.raise_for_status()
        results = (r.json() or {}).get("results") or {}
    except (requests.RequestException, ValueError):
        logger.info("逆ジオコーディングに失敗しました (lat=%s, lng=%s)", lat, lng, exc_info=True)
        return {}

    muni_cd = str(results.get("muniCd") or "").zfill(5)
    pref, muni = (_muni_table().get(muni_cd) or [None, None])
    if not pref:
        return {}
    return {"prefecture": pref, "municipality": muni}
