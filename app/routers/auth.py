"""会員登録・ログイン・ログアウト。"""
from flask import (Blueprint, render_template, redirect, url_for,
                   request, flash, current_app)
from flask_login import login_user, logout_user, login_required
from email_validator import validate_email, EmailNotValidError

from ..extensions import db, limiter
from ..models import User

bp = Blueprint("auth", __name__, url_prefix="/auth")


@bp.route("/register", methods=["GET", "POST"])
@limiter.limit("10 per hour")
def register():
    if not current_app.config["ALLOW_REGISTRATION"]:
        flash("現在、新規登録は受け付けていません。", "error")
        return redirect(url_for("auth.login"))

    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        email = (request.form.get("email") or "").strip()
        password = request.form.get("password") or ""

        errors = []
        if len(username) < 3:
            errors.append("ユーザー名は3文字以上にしてください。")
        if len(password) < 8:
            errors.append("パスワードは8文字以上にしてください。")
        try:
            validate_email(email, check_deliverability=False)
        except EmailNotValidError:
            errors.append("メールアドレスの形式が正しくありません。")
        if User.query.filter_by(username=username).first():
            errors.append("そのユーザー名は既に使われています。")
        if User.query.filter_by(email=email).first():
            errors.append("そのメールアドレスは既に登録されています。")

        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("register.html", username=username, email=email)

        user = User(username=username, email=email)
        user.set_password(password)
        # 最初に登録したユーザーを自動的に管理者にする
        if User.query.count() == 0:
            user.is_admin = True
        db.session.add(user)
        db.session.commit()
        login_user(user)
        flash("登録が完了しました。ようこそ ZENFUN へ。", "success")
        return redirect(url_for("main.index"))

    return render_template("register.html")


@bp.route("/login", methods=["GET", "POST"])
@limiter.limit("20 per hour")
def login():
    if request.method == "POST":
        identifier = (request.form.get("identifier") or "").strip()
        password = request.form.get("password") or ""
        user = (User.query.filter_by(username=identifier).first()
                or User.query.filter_by(email=identifier).first())
        if user and user.check_password(password):
            login_user(user, remember=True)
            flash("ログインしました。", "success")
            next_url = request.args.get("next")
            return redirect(next_url or url_for("main.index"))
        flash("ユーザー名またはパスワードが正しくありません。", "error")
    return render_template("login.html")


@bp.route("/logout")
@login_required
def logout():
    logout_user()
    flash("ログアウトしました。", "success")
    return redirect(url_for("main.index"))
