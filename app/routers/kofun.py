"""古墳データ API（一覧・絞り込み・追加・編集・削除・履歴）。

一般ユーザーの追加・編集・削除は即時反映されず PendingChange (承認待ちキュー)に入る。
管理者(is_admin)の操作のみ即時反映される。荒らし対策の土台。
"""
import json

from flask import Blueprint, request, jsonify, abort, current_app
from flask_login import login_required, current_user
from sqlalchemy import text

from ..extensions import db, limiter
from ..models import Kofun, EditHistory, PendingChange, KOFUN_SHAPES

bp = Blueprint("kofun", __name__, url_prefix="/api/kofun")

# 追加・編集で受け付けるフィールド
EDITABLE_FIELDS = [
    "name", "name_kana", "aliases", "latitude", "longitude",
    "prefecture", "municipality", "shape", "length_m", "height_m",
    "orientation_deg", "period", "year_from", "year_to",
    "description", "designation", "source_url", "outline_geojson",
]

FLOAT_FIELDS = {"latitude", "longitude", "length_m", "height_m", "orientation_deg"}
INT_FIELDS = {"year_from", "year_to"}

WRITE_RATE_LIMIT = "30 per hour"


def _normalize_outline(value):
    """輪郭JSONを検証・正規化する。不正な形式や点数不足のリングは保存しない。
    形式: {"mound": [[lng,lat], ...],
            "moats": [{"outer": [...], "inner": [...]}, ...],
            "lines": [[[lng,lat], ...], ...]}。
    周堤(moat)は二重・三重の周濠を持つ古墳もあるため配列で複数持てる。各周堤は
    外側・内側の輪をなぞり、両方そろえばその間の輪状の領域、片方だけならその輪単体を
    面として扱う（少なくとも一方が3点以上そろって初めて有効）。
    線(lines)は閉じない単純な線分列で、少なくとも2点あれば有効。"""
    try:
        data = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None

    def _ring(val, min_pts=3):
        if not isinstance(val, list):
            return None
        pts = []
        for p in val:
            if (isinstance(p, (list, tuple)) and len(p) == 2
                    and all(isinstance(c, (int, float)) for c in p)):
                pts.append([float(p[0]), float(p[1])])
        return pts if len(pts) >= min_pts else None

    result = {}
    mound = _ring(data.get("mound"))
    if mound:
        result["mound"] = mound

    moats = []
    raw_moats = data.get("moats")
    for m in (raw_moats if isinstance(raw_moats, list) else []):
        if not isinstance(m, dict):
            continue
        outer, inner = _ring(m.get("outer")), _ring(m.get("inner"))
        if outer or inner:
            entry = {}
            if outer:
                entry["outer"] = outer
            if inner:
                entry["inner"] = inner
            moats.append(entry)
    if moats:
        result["moats"] = moats

    lines = []
    raw_lines = data.get("lines")
    for l in (raw_lines if isinstance(raw_lines, list) else []):
        pts = _ring(l, min_pts=2)
        if pts:
            lines.append(pts)
    if lines:
        result["lines"] = lines

    return json.dumps(result, ensure_ascii=False) if result else None


def _coerce(field, value):
    if value is None or value == "":
        return None
    if field in FLOAT_FIELDS:
        return float(value)
    if field in INT_FIELDS:
        return int(value)
    if field == "outline_geojson":
        return _normalize_outline(value)
    return value


def _editable_snapshot(kofun):
    """差し戻しで使うスナップショット。EDITABLE_FIELDS と同じキー名(DB属性名)で保持する
    (to_dict() は表示用に latitude→lat 等キー名を変えており、そのままでは差し戻しに使えない)。"""
    return {f: getattr(kofun, f) for f in EDITABLE_FIELDS}


def _record_history(kofun, action, before, after):
    hist = EditHistory(
        kofun_id=kofun.id,
        user_id=current_user.id if current_user.is_authenticated else None,
        action=action,
        snapshot_before=json.dumps(before, ensure_ascii=False) if before else None,
        snapshot_after=json.dumps(after, ensure_ascii=False) if after else None,
    )
    db.session.add(hist)


def _validate_create(data):
    if not data.get("name") or data.get("latitude") in (None, "") \
            or data.get("longitude") in (None, ""):
        return "名称・緯度・経度は必須です。"
    return None


def _apply_bbox_filter(q, min_lat, max_lat, min_lng, max_lng):
    """地図表示範囲での絞り込み。PostGIS のセットアップに成功している場合は geom 列の
    GiST 索引を使い、それ以外(SQLite、または postgis 拡張が使えない環境)では
    緯度経度の複合索引を使う。"""
    if current_app.config.get("POSTGIS_ENABLED"):
        envelope = text(
            "geom && ST_MakeEnvelope(:min_lng, :min_lat, :max_lng, :max_lat, 4326)"
        ).bindparams(min_lng=min_lng, min_lat=min_lat, max_lng=max_lng, max_lat=max_lat)
        return q.filter(envelope)
    return q.filter(
        Kofun.latitude >= min_lat, Kofun.latitude <= max_lat,
        Kofun.longitude >= min_lng, Kofun.longitude <= max_lng,
    )


@bp.route("", methods=["GET"])
def list_kofun():
    """地図・リスト用。バウンディングボックス＋絞り込み。規模に関わらず全件を対象とする
    (大量件数はフロント側の MapLibre クラスタリングで描画負荷を抑える)。"""
    q = Kofun.query.filter_by(is_deleted=False)

    try:
        if request.args.get("min_lat"):
            q = _apply_bbox_filter(
                q,
                float(request.args["min_lat"]), float(request.args["max_lat"]),
                float(request.args["min_lng"]), float(request.args["max_lng"]),
            )
    except (ValueError, KeyError):
        pass

    # 検索・絞り込み
    if kw := request.args.get("q"):
        like = f"%{kw}%"
        q = q.filter(db.or_(Kofun.name.like(like),
                            Kofun.name_kana.like(like),
                            Kofun.aliases.like(like),
                            Kofun.municipality.like(like)))
    if pref := request.args.get("prefecture"):
        q = q.filter(Kofun.prefecture == pref)
    if shape := request.args.get("shape"):
        q = q.filter(Kofun.shape == shape)
    if period := request.args.get("period"):
        q = q.filter(Kofun.period.like(f"%{period}%"))
    if request.args.get("min_length"):
        q = q.filter(Kofun.length_m >= float(request.args["min_length"]))
    if request.args.get("max_length"):
        q = q.filter(Kofun.length_m <= float(request.args["max_length"]))

    limit = min(request.args.get("limit", 2000, type=int), 5000)
    items = q.order_by(Kofun.length_m.desc().nullslast()).limit(limit).all()
    return jsonify({
        "count": len(items),
        "shapes": KOFUN_SHAPES,
        "items": [k.to_dict() for k in items],
    })


@bp.route("/<int:kofun_id>", methods=["GET"])
def get_kofun(kofun_id):
    k = db.session.get(Kofun, kofun_id)
    if not k or k.is_deleted:
        abort(404)
    return jsonify(k.to_dict())


@bp.route("", methods=["POST"])
@login_required
@limiter.limit(WRITE_RATE_LIMIT)
def create_kofun():
    data = request.get_json(silent=True) or {}
    error = _validate_create(data)
    if error:
        return jsonify({"error": error}), 400

    if current_user.is_admin:
        k = Kofun(created_by=current_user.id, updated_by=current_user.id,
                  data_source=data.get("data_source", "manual"))
        for field in EDITABLE_FIELDS:
            if field in data:
                setattr(k, field, _coerce(field, data[field]))
        if k.shape not in KOFUN_SHAPES:
            k.shape = "unknown"
        db.session.add(k)
        db.session.flush()  # id を確定
        _record_history(k, "create", None, _editable_snapshot(k))
        db.session.commit()
        return jsonify(k.to_dict()), 201

    payload = {f: data[f] for f in EDITABLE_FIELDS if f in data}
    pc = PendingChange(action="create", data_source=data.get("data_source", "manual"),
                        submitted_by=current_user.id, status="pending",
                        payload=json.dumps(payload, ensure_ascii=False))
    db.session.add(pc)
    db.session.commit()
    return jsonify({"pending": True, "message": "追加内容を送信しました。管理者の承認後に地図へ反映されます。"}), 202


@bp.route("/<int:kofun_id>", methods=["PUT", "PATCH"])
@login_required
@limiter.limit(WRITE_RATE_LIMIT)
def update_kofun(kofun_id):
    k = db.session.get(Kofun, kofun_id)
    if not k or k.is_deleted:
        abort(404)
    data = request.get_json(silent=True) or {}

    if current_user.is_admin:
        before = _editable_snapshot(k)
        for field in EDITABLE_FIELDS:
            if field in data:
                setattr(k, field, _coerce(field, data[field]))
        if k.shape not in KOFUN_SHAPES:
            k.shape = "unknown"
        k.updated_by = current_user.id
        _record_history(k, "update", before, _editable_snapshot(k))
        db.session.commit()
        return jsonify(k.to_dict())

    payload = {f: data[f] for f in EDITABLE_FIELDS if f in data}
    pc = PendingChange(kofun_id=k.id, action="update", data_source=k.data_source,
                        submitted_by=current_user.id, status="pending",
                        payload=json.dumps(payload, ensure_ascii=False))
    db.session.add(pc)
    db.session.commit()
    return jsonify({"pending": True, "message": "編集内容を送信しました。管理者の承認後に反映されます。"}), 202


@bp.route("/<int:kofun_id>", methods=["DELETE"])
@login_required
@limiter.limit(WRITE_RATE_LIMIT)
def delete_kofun(kofun_id):
    k = db.session.get(Kofun, kofun_id)
    if not k or k.is_deleted:
        abort(404)

    if current_user.is_admin:
        before = _editable_snapshot(k)
        k.is_deleted = True          # 論理削除。履歴から復元可能。
        k.updated_by = current_user.id
        _record_history(k, "delete", before, None)
        db.session.commit()
        return jsonify({"ok": True})

    pc = PendingChange(kofun_id=k.id, action="delete", data_source=k.data_source,
                        submitted_by=current_user.id, status="pending")
    db.session.add(pc)
    db.session.commit()
    return jsonify({"pending": True, "message": "削除を申請しました。管理者の承認後に反映されます。"}), 202


@bp.route("/<int:kofun_id>/history", methods=["GET"])
def history(kofun_id):
    items = (EditHistory.query.filter_by(kofun_id=kofun_id)
             .order_by(EditHistory.created_at.desc()).limit(100).all())
    return jsonify([{
        "id": h.id,
        "action": h.action,
        "user_id": h.user_id,
        "username": h.user.username if h.user else "（不明）",
        "created_at": h.created_at.isoformat(),
        "has_snapshot": bool(h.snapshot_before),
    } for h in items])
