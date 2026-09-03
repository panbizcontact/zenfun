"""トップ（地図）ページと補助エンドポイント。"""
from flask import Blueprint, render_template, jsonify, request

from ..geocode import reverse_geocode
from ..models import KOFUN_SHAPES

bp = Blueprint("main", __name__)

PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]


@bp.route("/")
def index():
    return render_template(
        "index.html",
        prefectures=PREFECTURES,
        shapes=KOFUN_SHAPES,
    )


@bp.route("/api/meta")
def meta():
    return jsonify({
        "prefectures": PREFECTURES,
        "shapes": KOFUN_SHAPES,
    })


@bp.route("/api/reverse-geocode")
def reverse_geocode_api():
    """緯度経度から都道府県・市区町村を返す（編集画面の自動入力用）。
    解決できない場合も 200 で空の値を返し、入力を妨げない。"""
    try:
        lat = float(request.args["lat"])
        lng = float(request.args["lng"])
    except (KeyError, ValueError):
        return jsonify({"error": "lat と lng が必要です。"}), 400
    return jsonify(reverse_geocode(lat, lng))
