import os
import uuid
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import resend
from flask import Flask, jsonify, request, send_from_directory, redirect, make_response
from db import init_db, get_db
from recommender import get_next_song, record_feedback

app = Flask(__name__, static_folder='static')
init_db()

JWT_SECRET = os.getenv('JWT_SECRET', '')


def get_user_id():
    token = request.cookies.get('auth')
    if not token or not JWT_SECRET:
        return ''
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload.get('user_id', '')
    except jwt.InvalidTokenError:
        return ''


@app.route('/auth/send-link', methods=['POST'])
def send_link():
    data = request.get_json(silent=True) or {}
    email = data.get('email', '').strip().lower()
    if not email or '@' not in email:
        return jsonify({'error': 'Invalid email'}), 400

    conn = get_db()
    row = conn.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
    if row:
        user_id = row['id']
    else:
        user_id = str(uuid.uuid4())
        conn.execute('INSERT INTO users (id, email) VALUES (?, ?)', (user_id, email))
        conn.commit()

    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
    conn.execute(
        'INSERT INTO magic_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
        (token, user_id, expires_at),
    )
    conn.commit()
    conn.close()

    link = request.host_url.rstrip('/') + f'/auth/verify?token={token}'
    resend.api_key = os.getenv('RESEND_API_KEY', '')
    resend.Emails.send({
        'from': os.getenv('FROM_EMAIL', 'onboarding@resend.dev'),
        'to': email,
        'subject': 'Your Music Recommender login link',
        'html': f'<p><a href="{link}">Click here to log in</a></p><p>Expires in 15 minutes.</p>',
    })

    return jsonify({'ok': True})


@app.route('/auth/verify')
def verify():
    token = request.args.get('token', '')
    conn = get_db()
    row = conn.execute(
        'SELECT user_id, expires_at, used FROM magic_tokens WHERE token = ?', (token,)
    ).fetchone()
    conn.close()

    if not row or row['used']:
        return redirect('/?error=invalid')

    expires_at = datetime.fromisoformat(row['expires_at'])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return redirect('/?error=expired')

    conn = get_db()
    conn.execute('UPDATE magic_tokens SET used = 1 WHERE token = ?', (token,))
    conn.commit()
    conn.close()

    jwt_token = jwt.encode(
        {'user_id': row['user_id'], 'exp': datetime.now(timezone.utc) + timedelta(days=30)},
        JWT_SECRET,
        algorithm='HS256',
    )
    resp = make_response(redirect('/'))
    resp.set_cookie('auth', jwt_token, httponly=True, secure=True, samesite='Lax', max_age=30 * 24 * 3600)
    return resp


@app.route('/auth/me')
def auth_me():
    user_id = get_user_id()
    return jsonify({'user_id': user_id or None})


@app.route('/auth/logout', methods=['POST'])
def logout():
    resp = make_response(jsonify({'ok': True}))
    resp.delete_cookie('auth')
    return resp


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)


@app.route('/api/next')
def next_song():
    seed   = request.args.get('seed')
    artist = request.args.get('artist')
    song   = get_next_song(get_user_id(), seed=seed, artist=artist)
    if song:
        return jsonify(song)
    return jsonify({'error': 'No songs found'}), 503


@app.route('/api/similar-artists')
def similar_artists():
    video_id       = request.args.get('video_id')
    exclude_artist = request.args.get('exclude_artist', '')
    if not video_id:
        return jsonify({'artists': []})
    try:
        from recommender import yt
        watch = yt.get_watch_playlist(videoId=video_id, limit=25)
        seen, artists = set(), []
        for track in watch.get('tracks', []):
            track_artists = track.get('artists') or []
            if not track_artists:
                continue
            a    = track_artists[0]
            name = (a.get('name') or '').strip()
            aid  = a.get('id') or ''
            if not name or name in seen or aid == exclude_artist:
                continue
            seen.add(name)
            artists.append({'name': name, 'id': aid})
            if len(artists) >= 6:
                break
        return jsonify({'artists': artists})
    except Exception:
        return jsonify({'artists': []})


@app.route('/api/feedback', methods=['POST'])
def feedback():
    d = request.json
    record_feedback(
        user_id     = get_user_id(),
        video_id    = d['video_id'],
        title       = d.get('title'),
        artist_name = d.get('artist_name'),
        artist_id   = d.get('artist_id'),
        completion  = d['completion'],
        liked       = d['liked'],
    )
    return jsonify({'ok': True})


@app.route('/api/superlike', methods=['POST'])
def superlike():
    d = request.json
    record_feedback(
        user_id     = get_user_id(),
        video_id    = d['video_id'],
        title       = d.get('title'),
        artist_name = d.get('artist_name'),
        artist_id   = d.get('artist_id'),
        completion  = d.get('completion', 1.0),
        liked       = True,
        superliked  = True,
    )
    return jsonify({'ok': True})


@app.route('/api/skip-reason', methods=['POST'])
def skip_reason():
    d = request.json
    user_id = get_user_id()
    db = get_db()
    db.execute(
        '''UPDATE plays SET skip_reason=?
           WHERE id=(SELECT MAX(id) FROM plays WHERE user_id=? AND video_id=?)''',
        (d['reason'], user_id, d['video_id'])
    )
    db.commit()
    db.close()
    return jsonify({'ok': True})


@app.route('/api/stats')
def stats():
    user_id = get_user_id()
    db = get_db()
    total  = db.execute('SELECT COUNT(*) as n FROM plays WHERE user_id=? AND liked IS NOT NULL', (user_id,)).fetchone()['n']
    liked  = db.execute('SELECT COUNT(*) as n FROM plays WHERE user_id=? AND liked=1', (user_id,)).fetchone()['n']
    top    = db.execute('''
        SELECT artist_name, like_count, skip_count
        FROM artist_scores
        WHERE user_id=?
        ORDER BY like_count - skip_count DESC
        LIMIT 5
    ''', (user_id,)).fetchall()
    db.close()
    return jsonify({
        'total':   total,
        'liked':   liked,
        'skipped': total - liked,
        'top_artists': [dict(r) for r in top],
    })


@app.route('/api/trend')
def trend():
    user_id = get_user_id()
    db = get_db()
    rows = db.execute('''
        SELECT liked FROM plays
        WHERE user_id=? AND liked IS NOT NULL
        ORDER BY played_at DESC
        LIMIT 50
    ''', (user_id,)).fetchall()
    db.close()
    rows = rows[::-1]  # oldest first
    bucket_size = 5
    buckets = []
    for i in range(0, len(rows), bucket_size):
        chunk = rows[i:i+bucket_size]
        if len(chunk) < bucket_size:
            break  # skip incomplete last bucket
        buckets.append(round(sum(r['liked'] for r in chunk) / bucket_size, 2))
    return jsonify({'buckets': buckets})


if __name__ == '__main__':
    app.run(debug=True, port=5001)
