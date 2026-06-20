from flask import Flask, render_template, jsonify, request, session
import json
import os
from functools import wraps

app = Flask(__name__)

# セッション(ログイン状態の保持)に使う秘密鍵。
# 本番運用では必ず環境変数 SECRET_KEY を設定してください。
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# 管理者パスワード。
# セキュリティのため、環境変数 ADMIN_PASSWORD が未設定の場合は起動時にエラーにする。
# (デフォルト値のまま公開してしまい、誰でも管理者ログインできる事故を防ぐため)
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD')
if not ADMIN_PASSWORD:
    raise RuntimeError(
        '環境変数 ADMIN_PASSWORD が設定されていません。\n'
        '管理者パスワードを環境変数で設定してから起動してください。\n'
        '例 (Mac/Linux): export ADMIN_PASSWORD="強力なパスワード"\n'
        '例 (Windows):   set ADMIN_PASSWORD=強力なパスワード'
    )

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'kofun.json')


def load_kofun():
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_kofun(kofun_list):
    # 一時ファイルに書いてから置き換えることで、書き込み中の破損を防ぐ
    tmp_path = DATA_PATH + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(kofun_list, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, DATA_PATH)


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('is_admin'):
            return jsonify({'error': '管理者ログインが必要です'}), 401
        return f(*args, **kwargs)
    return decorated


def _to_number_or_blank(value):
    """空文字/None はそのまま空文字に、それ以外は数値に変換する"""
    if value is None or value == '':
        return ''
    try:
        num = float(value)
        # 整数値ならintとして保存（既存データのスタイルに合わせる）
        if num.is_integer():
            return int(num)
        return num
    except (TypeError, ValueError):
        return ''


def _to_int_or_none(value):
    if value is None or value == '':
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/kofun')
def api_kofun():
    kofun_list = load_kofun()

    # Filtering
    prefecture = request.args.get('prefecture', '')
    era = request.args.get('era', '')
    kofun_type = request.args.get('type', '')
    query = request.args.get('q', '')
    world_heritage = request.args.get('world_heritage', '')
    sort = request.args.get('sort', '')

    if prefecture:
        kofun_list = [k for k in kofun_list if k['prefecture'] == prefecture]
    if era:
        kofun_list = [k for k in kofun_list if era in k['era']]
    if kofun_type:
        kofun_list = [k for k in kofun_list if kofun_type in k['type']]
    if world_heritage == 'true':
        kofun_list = [k for k in kofun_list if k.get('world_heritage')]
    if query:
        q = query.lower()
        kofun_list = [
            k for k in kofun_list
            if q in k['name'].lower()
            or q in k.get('yomi', '').lower()
            or q in k.get('description', '').lower()
            or q in k.get('prefecture', '').lower()
            or q in k.get('city', '').lower()
        ]
    if sort == 'length':
        kofun_list = sorted(kofun_list, key=lambda k: k.get('length_m') or 0, reverse=True)

    return jsonify(kofun_list)


@app.route('/api/kofun', methods=['POST'])
@admin_required
def api_kofun_create():
    """管理者のみ: 新しい古墳を地図上の指定座標に追加する"""
    data = request.get_json(force=True, silent=True) or {}

    required_fields = ['name', 'prefecture', 'city', 'type']
    missing = [field for field in required_fields if not str(data.get(field, '')).strip()]
    if missing:
        return jsonify({'error': f'必須項目が不足しています: {", ".join(missing)}'}), 400

    if 'lat' not in data or 'lng' not in data:
        return jsonify({'error': '緯度・経度が指定されていません'}), 400
    try:
        lat = float(data['lat'])
        lng = float(data['lng'])
    except (TypeError, ValueError):
        return jsonify({'error': '緯度・経度の値が不正です'}), 400
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return jsonify({'error': '緯度・経度の値が範囲外です'}), 400

    kofun_list = load_kofun()
    new_id = max((k['id'] for k in kofun_list), default=0) + 1

    try:
        state = int(data.get('state', 2))
    except (TypeError, ValueError):
        state = 2
    if state not in (0, 1, 2):
        state = 2

    new_kofun = {
        'id': new_id,
        'name': str(data.get('name', '')).strip(),
        'yomi': str(data.get('yomi', '')).strip(),
        'prefecture': str(data.get('prefecture', '')).strip(),
        'city': str(data.get('city', '')).strip(),
        'lat': lat,
        'lng': lng,
        'era': str(data.get('era', '')).strip(),
        'century': str(data.get('century', '')).strip(),
        'type': str(data.get('type', '')).strip(),
        'length_m': _to_number_or_blank(data.get('length_m')),
        'height_m': _to_number_or_blank(data.get('height_m')),
        'description': str(data.get('description', '')).strip(),
        'photo_url': str(data.get('photo_url', '')).strip(),
        'world_heritage': bool(data.get('world_heritage')),
        'national_historic_site': bool(data.get('national_historic_site')),
        'state': state,
        'direction': _to_int_or_none(data.get('direction')),
    }

    kofun_list.append(new_kofun)
    save_kofun(kofun_list)

    return jsonify(new_kofun), 201


@app.route('/api/kofun/<int:kofun_id>')
def api_kofun_detail(kofun_id):
    kofun_list = load_kofun()
    kofun = next((k for k in kofun_list if k['id'] == kofun_id), None)
    if not kofun:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(kofun)


@app.route('/api/kofun/<int:kofun_id>', methods=['PUT'])
@admin_required
def api_kofun_update(kofun_id):
    """管理者のみ: 既存の古墳データを上書き更新する"""
    kofun_list = load_kofun()
    idx = next((i for i, k in enumerate(kofun_list) if k['id'] == kofun_id), None)
    if idx is None:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json(force=True, silent=True) or {}

    required_fields = ['name', 'prefecture', 'city', 'type']
    missing = [field for field in required_fields if not str(data.get(field, '')).strip()]
    if missing:
        return jsonify({'error': f'必須項目が不足しています: {", ".join(missing)}'}), 400

    existing = kofun_list[idx]

    # 緯度・経度が送られてきた場合のみ更新
    if 'lat' in data and 'lng' in data:
        try:
            lat = float(data['lat'])
            lng = float(data['lng'])
        except (TypeError, ValueError):
            return jsonify({'error': '緯度・経度の値が不正です'}), 400
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return jsonify({'error': '緯度・経度の値が範囲外です'}), 400
        existing['lat'] = lat
        existing['lng'] = lng

    try:
        state = int(data.get('state', existing.get('state', 2)))
    except (TypeError, ValueError):
        state = existing.get('state', 2)
    if state not in (0, 1, 2):
        state = existing.get('state', 2)

    existing.update({
        'name': str(data.get('name', existing['name'])).strip(),
        'yomi': str(data.get('yomi', existing.get('yomi', ''))).strip(),
        'prefecture': str(data.get('prefecture', existing['prefecture'])).strip(),
        'city': str(data.get('city', existing['city'])).strip(),
        'era': str(data.get('era', existing.get('era', ''))).strip(),
        'century': str(data.get('century', existing.get('century', ''))).strip(),
        'type': str(data.get('type', existing['type'])).strip(),
        'length_m': _to_number_or_blank(data.get('length_m', existing.get('length_m'))),
        'height_m': _to_number_or_blank(data.get('height_m', existing.get('height_m'))),
        'description': str(data.get('description', existing.get('description', ''))).strip(),
        'photo_url': str(data.get('photo_url', existing.get('photo_url', ''))).strip(),
        'world_heritage': bool(data.get('world_heritage', existing.get('world_heritage', False))),
        'national_historic_site': bool(data.get('national_historic_site', existing.get('national_historic_site', False))),
        'state': state,
        'direction': _to_int_or_none(data.get('direction', existing.get('direction'))),
    })

    kofun_list[idx] = existing
    save_kofun(kofun_list)
    return jsonify(existing)


@app.route('/api/kofun/<int:kofun_id>', methods=['DELETE'])
@admin_required
def api_kofun_delete(kofun_id):
    """管理者のみ: 古墳を削除する(誤って追加した場合の取り消し用)"""
    kofun_list = load_kofun()
    new_list = [k for k in kofun_list if k['id'] != kofun_id]
    if len(new_list) == len(kofun_list):
        return jsonify({'error': 'Not found'}), 404
    save_kofun(new_list)
    return jsonify({'success': True})


@app.route('/api/stats')
def api_stats():
    kofun_list = load_kofun()
    prefectures = sorted(set(k['prefecture'] for k in kofun_list))
    eras = sorted(set(k['era'] for k in kofun_list))
    types = sorted(set(k['type'] for k in kofun_list))
    return jsonify({
        'total': len(kofun_list),
        'prefectures': prefectures,
        'eras': eras,
        'types': types,
        'world_heritage_count': sum(1 for k in kofun_list if k.get('world_heritage'))
    })


# ── 管理者ログイン ──────────────────────────────────────────
@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    data = request.get_json(force=True, silent=True) or {}
    password = data.get('password', '')
    if password and password == ADMIN_PASSWORD:
        session['is_admin'] = True
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'パスワードが正しくありません'}), 401


@app.route('/api/admin/logout', methods=['POST'])
def admin_logout():
    session.pop('is_admin', None)
    return jsonify({'success': True})


@app.route('/api/admin/status')
def admin_status():
    return jsonify({'is_admin': bool(session.get('is_admin'))})


if __name__ == '__main__':
    # FLASK_DEBUG=1 を設定したときだけデバッグモードで起動する
    # (デバッグモードを公開環境で有効にすると、第三者がサーバー上で
    #  任意のコードを実行できてしまう深刻な脆弱性になるため)
    debug_mode = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=8080, debug=debug_mode)
