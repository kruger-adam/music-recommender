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
    song = get_next_song(get_user_id())
    if song:
        return jsonify(song)
    return jsonify({'error': 'No songs found'}), 503


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


if __name__ == '__main__':
    app.run(debug=True, port=5001)
