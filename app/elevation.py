"""国土地理院の標高APIを用いた墳丘高の推定。

「墳丘高」は周囲の地面からの高さなので、単に中心地点の標高を入れると
（海抜がそのまま入ってしまい）意味が変わってしまう。そこで
    墳丘高 ≒ 墳頂の標高 − 周囲の基準面の標高
として求める。墳頂は、中心の一点ではなく墳丘の内側を何点か測ってその
最高標高をとる（墳頂が中心からずれている古墳や、中心が凹んでいる場合に
実際より低く出るのを避けるため）。周囲の基準面は、Path（墳丘の輪郭）が
あればその頂点、なければ中心から一定距離の円周上の点をサンプリングし、
その中央値を使う。

いずれもDEM（数値標高モデル）由来の概算値であり、実測値の代わりにはならない。
"""
import logging
import math
from functools import lru_cache

import requests

logger = logging.getLogger(__name__)

GSI_ELEVATION = "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php"
USER_AGENT = "ZENFUN/1.0 (https://zenfun.onrender.com)"
TIMEOUT_SEC = 8
MAX_SAMPLES = 8          # 周囲のサンプリング点数（APIへの負荷を抑える）
INNER_SAMPLES = 8        # 墳頂を探すために墳丘の内側を測る点数
INNER_RATIO = 0.5        # 内側の点をどのくらい中心寄りに取るか
DEFAULT_BASE_RADIUS_M = 40.0


@lru_cache(maxsize=2048)
def _elevation_cached(lat_r: float, lng_r: float):
    """標高を取得する。取得できなければ None。座標は丸めた値でキャッシュする。"""
    try:
        r = requests.get(
            GSI_ELEVATION,
            params={"lat": lat_r, "lon": lng_r, "outtype": "JSON"},
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT_SEC,
        )
        r.raise_for_status()
        value = (r.json() or {}).get("elevation")
    except (requests.RequestException, ValueError):
        logger.info("標高の取得に失敗しました (lat=%s, lng=%s)", lat_r, lng_r, exc_info=True)
        return None
    try:
        return float(value)      # 圏外は "-----" が返るため float 変換で弾く
    except (TypeError, ValueError):
        return None


def get_elevation(lat: float, lng: float):
    # 5mメッシュDEMに対し十分な精度（小数6桁 ≒ 0.1m）に丸めてキャッシュ効率を上げる
    return _elevation_cached(round(lat, 6), round(lng, 6))


def _ring_samples(ring, limit=MAX_SAMPLES):
    """輪郭の頂点から等間隔に最大 limit 点を選ぶ。"""
    if len(ring) <= limit:
        return list(ring)
    step = len(ring) / limit
    return [ring[int(i * step)] for i in range(limit)]


def _circle_samples(lat, lng, radius_m, count=MAX_SAMPLES):
    """中心から radius_m 離れた円周上の点を count 個返す。"""
    lat_per_m = 1.0 / 110540.0
    lng_per_m = 1.0 / (111320.0 * max(math.cos(math.radians(lat)), 0.01))
    pts = []
    for i in range(count):
        theta = 2 * math.pi * i / count
        pts.append([
            lng + radius_m * math.cos(theta) * lng_per_m,
            lat + radius_m * math.sin(theta) * lat_per_m,
        ])
    return pts


def _inner_samples(lat, lng, ring=None, radius_m=None, count=INNER_SAMPLES):
    """墳丘の内側の点を返す。Pathがあれば重心と各頂点の間を、なければ中心の
    まわりの小さな円をとる。中心そのものは呼び出し側で必ず測る。"""
    if ring and len(ring) >= 3:
        pts = _ring_samples(ring, count)
        c_lng = sum(p[0] for p in pts) / len(pts)
        c_lat = sum(p[1] for p in pts) / len(pts)
        return [[c_lng + (p[0] - c_lng) * INNER_RATIO,
                 c_lat + (p[1] - c_lat) * INNER_RATIO] for p in pts]
    r = (radius_m or DEFAULT_BASE_RADIUS_M) * INNER_RATIO
    return _circle_samples(lat, lng, r, count)


def _median(values):
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def base_radius_for(length_m=None) -> float:
    """周囲の基準面をサンプリングする円の半径。墳丘長が分かっていれば、その外側に
    出るよう余裕をもたせる（小さい古墳で円が墳丘上に収まってしまうのを避ける）。"""
    if not length_m:
        return DEFAULT_BASE_RADIUS_M
    return max(length_m / 2 * 1.5, DEFAULT_BASE_RADIUS_M)


def estimate_mound_height(lat: float, lng: float, ring=None, base_radius_m=None) -> dict:
    """墳丘高の推定値を返す。
    {"height_m": 12.3, "summit_m": 36.2, "base_m": 23.9, "samples": 8} 形式。
    取得できない場合は height_m を None にして返す（例外は投げない）。"""
    # 墳頂: 中心と墳丘の内側を測り、その最高標高をとる
    summits = [get_elevation(lat, lng)]
    for lng_i, lat_i in _inner_samples(lat, lng, ring=ring, radius_m=base_radius_m):
        summits.append(get_elevation(lat_i, lng_i))
    summits = [e for e in summits if e is not None]
    if not summits:
        return {"height_m": None, "summit_m": None, "base_m": None, "samples": 0}
    summit = max(summits)

    if ring and len(ring) >= 3:
        sample_pts = _ring_samples(ring)
    else:
        radius = base_radius_m or DEFAULT_BASE_RADIUS_M
        sample_pts = _circle_samples(lat, lng, radius)

    base_values = []
    for lng_i, lat_i in sample_pts:
        e = get_elevation(lat_i, lng_i)
        if e is not None:
            base_values.append(e)

    if not base_values:
        return {"height_m": None, "summit_m": summit, "base_m": None, "samples": 0}

    base = _median(base_values)
    height = round(max(summit - base, 0.0), 1)
    return {
        "height_m": height,
        "summit_m": round(summit, 1),
        "base_m": round(base, 1),
        "samples": len(base_values),
    }
