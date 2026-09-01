"""管理者向け: 承認待ちレビュー・承認/却下・履歴の差し戻し。"""
import json
from datetime import datetime

from flask import Blueprint, render_template, jsonify, request, abort
from flask_login import login_required, current_user

from ..extensions import db
from ..models import Kofun, EditHistory, PendingChange, KOFUN_SHAPES
from .kofun import EDITABLE_FIELDS, _coerce, _record_history, _editable_snapshot

bp = Blueprint("admin", __name__)


def _require_admin():
    if not current_user.is_authenticated or not current_user.is_admin:
        abort(403)


@bp.route("/admin/review")
@login_required
def review_page():
    _require_admin()
    return render_template("admin_review.html")


@bp.route("/api/admin/pending", methods=["GET"])
@login_required
def list_pending():
    _require_admin()
    status = request.args.get("status", "pending")
    q = PendingChange.query
    if status != "all":
        q = q.filter_by(status=status)
    items = q.order_by(PendingChange.created_at.desc()).limit(300).all()
    return jsonify([p.to_dict() for p in items])


@bp.route("/api/admin/pending/<int:pending_id>/approve", methods=["POST"])
@login_required
def approve_pending(pending_id):
    _require_admin()
    p = db.session.get(PendingChange, pending_id)
    if not p or p.status != "pending":
        abort(404)
    payload = json.loads(p.payload) if p.payload else {}

    if p.action == "create":
        k = Kofun(created_by=p.submitted_by, updated_by=p.submitted_by,
                  data_source=p.data_source or "manual")
        for field in EDITABLE_FIELDS:
            if field in payload:
                setattr(k, field, _coerce(field, payload[field]))
        if k.shape not in KOFUN_SHAPES:
            k.shape = "unknown"
        if not k.name or k.latitude is None or k.longitude is None:
            return jsonify({"error": "名称・緯度・経度が不足しているため承認できません。"}), 400
        db.session.add(k)
        db.session.flush()
        _record_history(k, "create", None, _editable_snapshot(k))
        p.kofun_id = k.id

    elif p.action == "update":
        k = db.session.get(Kofun, p.kofun_id)
        if not k or k.is_deleted:
            return jsonify({"error": "対象の古墳が見つかりません(削除済みの可能性)。"}), 404
        before = _editable_snapshot(k)
        for field in EDITABLE_FIELDS:
            if field in payload:
                setattr(k, field, _coerce(field, payload[field]))
        if k.shape not in KOFUN_SHAPES:
            k.shape = "unknown"
        k.updated_by = p.submitted_by
        _record_history(k, "update", before, _editable_snapshot(k))

    elif p.action == "delete":
        k = db.session.get(Kofun, p.kofun_id)
        if not k or k.is_deleted:
            return jsonify({"error": "対象の古墳が見つかりません(既に削除済みの可能性)。"}), 404
        before = _editable_snapshot(k)
        k.is_deleted = True
        k.updated_by = p.submitted_by
        _record_history(k, "delete", before, None)

    p.status = "approved"
    p.reviewed_by = current_user.id
    p.reviewed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/admin/pending/<int:pending_id>/reject", methods=["POST"])
@login_required
def reject_pending(pending_id):
    _require_admin()
    p = db.session.get(PendingChange, pending_id)
    if not p or p.status != "pending":
        abort(404)
    data = request.get_json(silent=True) or {}
    p.status = "rejected"
    p.review_note = (data.get("reason") or "").strip()[:500] or None
    p.reviewed_by = current_user.id
    p.reviewed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/kofun/<int:kofun_id>/history/<int:hist_id>/revert", methods=["POST"])
@login_required
def revert_history(kofun_id, hist_id):
    """指定した編集履歴の「変更前」の状態に差し戻す(荒らし対策)。"""
    _require_admin()
    hist = db.session.get(EditHistory, hist_id)
    if not hist or hist.kofun_id != kofun_id:
        abort(404)
    if not hist.snapshot_before:
        return jsonify({"error": "この版には差し戻し元の情報がありません。"}), 400

    k = db.session.get(Kofun, kofun_id)
    if not k:
        abort(404)
    before = _editable_snapshot(k)
    snap = json.loads(hist.snapshot_before)
    for field in EDITABLE_FIELDS:
        if field in snap:
            setattr(k, field, snap[field])
    k.is_deleted = False
    k.updated_by = current_user.id
    _record_history(k, "revert", before, _editable_snapshot(k))
    db.session.commit()
    return jsonify(k.to_dict())
