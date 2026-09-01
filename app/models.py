"""データベースモデル定義。"""
import json
from datetime import datetime

from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

from .extensions import db


# 古墳の形状。value はDB保存値、後半は日本語表示名。
KOFUN_SHAPES = {
    "zenpokoenfun": "前方後円墳",
    "hotategai": "帆立貝式古墳",
    "enpun": "円墳",
    "hofun": "方墳",
    "zenpokohofun": "前方後方墳",
    "unknown": "不明",
}


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    edits = db.relationship("EditHistory", back_populates="user", lazy="dynamic")

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class Kofun(db.Model):
    __tablename__ = "kofun"
    __table_args__ = (
        # 地図のバウンディングボックス検索(緯度・経度の範囲絞り込み)を高速化する複合索引。
        # PostgreSQL 移行後は PostGIS の GiST 索引(geom列)がこれを置き換える。
        db.Index("ix_kofun_lat_lng", "latitude", "longitude"),
    )

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False, index=True)
    name_kana = db.Column(db.String(255))            # ふりがな
    aliases = db.Column(db.String(500))              # 別名（カンマ区切り）

    # 位置
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    prefecture = db.Column(db.String(20), index=True)  # 都道府県
    municipality = db.Column(db.String(100))           # 市区町村

    # 形状・規模・向き
    shape = db.Column(db.String(32), default="unknown", index=True)  # KOFUN_SHAPES のキー
    length_m = db.Column(db.Float, index=True)   # 墳丘長(m)。円墳は直径。規模フィルタの基準。
    height_m = db.Column(db.Float)               # 墳丘高(m)
    # 方角: 前方後円墳などで「前方部が向く方位」を度で保持(0=北, 90=東)。
    orientation_deg = db.Column(db.Float, default=0.0)

    # 年代
    period = db.Column(db.String(50), index=True)  # 例: 前期/中期/後期、または世紀
    year_from = db.Column(db.Integer)              # 築造推定 開始年(西暦、BCは負)
    year_to = db.Column(db.Integer)                # 築造推定 終了年

    # 情報
    description = db.Column(db.Text)               # 解説
    designation = db.Column(db.String(100))        # 指定(国史跡など)
    source_url = db.Column(db.String(500))         # 出典URL(Wikipedia等)
    data_source = db.Column(db.String(50), default="manual")  # manual / wikipedia

    # 輪郭（ズーム11以上で表示するPath）。JSON文字列:
    # {"mound": [[lng,lat], ...], "moats": [{"outer": [...], "inner": [...]}, ...],
    #  "lines": [[[lng,lat], ...], ...]}
    # 周堤(moat)は二重・三重の周濠を持つ古墳もあるため配列で複数持てる。外側・内側の
    # 輪をなぞり、両方あれば間の輪状の領域、片方だけならその輪単体を面として扱う。
    # lines は閉じない単純な線（任意、いずれも任意項目）。
    # 会員が地図編集で作成し、他の項目と同じ承認フローで反映される。
    outline_geojson = db.Column(db.Text)

    # 管理
    is_deleted = db.Column(db.Boolean, default=False, nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow,
                           onupdate=datetime.utcnow, nullable=False)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    updated_by = db.Column(db.Integer, db.ForeignKey("users.id"))

    history = db.relationship("EditHistory", back_populates="kofun", lazy="dynamic")

    def shape_ja(self) -> str:
        return KOFUN_SHAPES.get(self.shape, "不明")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "name_kana": self.name_kana,
            "aliases": self.aliases,
            "lat": self.latitude,
            "lng": self.longitude,
            "prefecture": self.prefecture,
            "municipality": self.municipality,
            "shape": self.shape,
            "shape_ja": self.shape_ja(),
            "length_m": self.length_m,
            "height_m": self.height_m,
            "orientation_deg": self.orientation_deg or 0.0,
            "period": self.period,
            "year_from": self.year_from,
            "year_to": self.year_to,
            "description": self.description,
            "designation": self.designation,
            "source_url": self.source_url,
            "data_source": self.data_source,
            "outline": json.loads(self.outline_geojson) if self.outline_geojson else None,
            "has_outline": bool(self.outline_geojson),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class EditHistory(db.Model):
    """全編集を記録。荒らし対策・差し戻しの土台。"""
    __tablename__ = "edit_history"

    id = db.Column(db.Integer, primary_key=True)
    kofun_id = db.Column(db.Integer, db.ForeignKey("kofun.id"), index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    action = db.Column(db.String(20))  # create / update / delete / restore
    # 変更前後のスナップショット(JSON文字列)。差し戻しに使う。
    snapshot_before = db.Column(db.Text)
    snapshot_after = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    kofun = db.relationship("Kofun", back_populates="history")
    user = db.relationship("User", back_populates="edits")


class PendingChange(db.Model):
    """承認待ちの変更提案。一般編集者の投稿と bot の取り込みはここに入り、
    管理者が承認するまで Kofun 本体には反映されない(荒らし対策・bot精度対策の土台)。"""
    __tablename__ = "pending_changes"

    id = db.Column(db.Integer, primary_key=True)
    kofun_id = db.Column(db.Integer, db.ForeignKey("kofun.id"), index=True)  # create の場合は None
    action = db.Column(db.String(20), nullable=False)  # create / update / delete
    payload = db.Column(db.Text)  # 提案する変更内容(JSON文字列)
    data_source = db.Column(db.String(50), default="manual")  # manual / wikipedia

    submitted_by = db.Column(db.Integer, db.ForeignKey("users.id"))  # bot 由来は None
    status = db.Column(db.String(20), default="pending", nullable=False, index=True)  # pending/approved/rejected
    review_note = db.Column(db.String(500))
    reviewed_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    reviewed_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)

    kofun = db.relationship("Kofun")
    submitter = db.relationship("User", foreign_keys=[submitted_by])
    reviewer = db.relationship("User", foreign_keys=[reviewed_by])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kofun_id": self.kofun_id,
            "kofun_name": self.kofun.name if self.kofun else None,
            "action": self.action,
            "payload": json.loads(self.payload) if self.payload else None,
            "data_source": self.data_source,
            "submitted_by": self.submitted_by,
            "submitter_name": self.submitter.username if self.submitter else "Wikipedia bot",
            "status": self.status,
            "review_note": self.review_note,
            "reviewed_by": self.reviewed_by,
            "reviewer_name": self.reviewer.username if self.reviewer else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "reviewed_at": self.reviewed_at.isoformat() if self.reviewed_at else None,
        }
