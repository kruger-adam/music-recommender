from flask import Flask, jsonify, request, send_from_directory
from db import init_db, get_db
from recommender import get_next_song, record_feedback

app = Flask(__name__, static_folder='static')
init_db()


def get_user_id():
    return request.headers.get('X-User-ID', '')


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
