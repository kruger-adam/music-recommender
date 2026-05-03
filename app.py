from flask import Flask, jsonify, request, send_from_directory
from db import init_db, get_db
from recommender import get_next_song, record_feedback

app = Flask(__name__, static_folder='static')


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)


@app.route('/api/next')
def next_song():
    song = get_next_song()
    if song:
        return jsonify(song)
    return jsonify({'error': 'No songs found'}), 503


@app.route('/api/feedback', methods=['POST'])
def feedback():
    d = request.json
    record_feedback(
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
    db = get_db()
    total  = db.execute('SELECT COUNT(*) FROM plays WHERE liked IS NOT NULL').fetchone()[0]
    liked  = db.execute('SELECT COUNT(*) FROM plays WHERE liked=1').fetchone()[0]
    top    = db.execute('''
        SELECT artist_name, like_count, skip_count
        FROM artist_scores
        ORDER BY like_count - skip_count DESC
        LIMIT 5
    ''').fetchall()
    db.close()
    return jsonify({
        'total':   total,
        'liked':   liked,
        'skipped': total - liked,
        'top_artists': [dict(r) for r in top],
    })


if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5001)
