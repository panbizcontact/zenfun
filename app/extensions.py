"""拡張機能のインスタンス。循環インポートを避けるため分離。"""
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, current_user
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = "auth.login"
login_manager.login_message = "この操作にはログインが必要です。"


def rate_limit_key():
    """ログイン中はユーザー単位、未ログインはIP単位でレート制限する。"""
    if current_user.is_authenticated:
        return f"user:{current_user.id}"
    return get_remote_address()


# 既定のグローバル制限は設けない。地図の閲覧(GET /api/kofun 等)はパン・ズームのたびに
# 呼ばれるため、包括的な既定値を付けるとブラウジングだけで制限に達してしまう。
# 制限は書き込み系API・登録・ログインの各ルートに個別に付与する(kofun.py / auth.py 参照)。
limiter = Limiter(key_func=rate_limit_key)
