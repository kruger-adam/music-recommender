import random
from ytmusicapi import YTMusic
from db import get_db

yt = YTMusic()

LIKE_THRESHOLD = 0.80   # played ≥80% → liked
RECENT_WINDOW  = 50     # don't repeat last N played songs

SEED_QUERIES = [
    "top hits 2024", "popular songs 2024", "indie pop hits",
    "classic rock hits", "top rap 2024", "r&b hits 2024",
    "pop hits 2023", "electronic music hits", "alternative rock 2024",
    "best songs 2025",
]


def _parse_song(raw):
    video_id = raw.get('videoId')
    if not video_id:
        return None
    artists   = raw.get('artists') or []
    artist    = artists[0] if artists else {}
    album     = raw.get('album') or {}
    thumbs    = raw.get('thumbnails') or []
    duration  = raw.get('duration_seconds', 0)
    if duration and (duration < 60 or duration > 600):
        return None
    return {
        'video_id':    video_id,
        'title':       raw.get('title', 'Unknown'),
        'artist_name': artist.get('name', 'Unknown'),
        'artist_id':   artist.get('id'),
        'album':       album.get('name') if isinstance(album, dict) else None,
        'duration':    duration,
        'thumbnail':   (thumbs[-1].get('url') if thumbs
                       else f'https://img.youtube.com/vi/{video_id}/hqdefault.jpg'),
    }


def _artist_scores(user_id):
    db = get_db()
    rows = db.execute(
        'SELECT artist_id, like_count, skip_count FROM artist_scores WHERE user_id=?', (user_id,)
    ).fetchall()
    db.close()
    return {r['artist_id']: (r['like_count'], r['skip_count']) for r in rows if r['artist_id']}


def _recently_played(user_id):
    db = get_db()
    rows = db.execute(
        'SELECT video_id FROM plays WHERE user_id=? ORDER BY played_at DESC LIMIT ?',
        (user_id, RECENT_WINDOW)
    ).fetchall()
    db.close()
    return {r['video_id'] for r in rows}


def _score(song, scores):
    artist_id = song.get('artist_id')
    base = random.uniform(0, 1)
    if artist_id and artist_id in scores:
        likes, skips = scores[artist_id]
        base += likes * 3 - skips * 2
    return base


def _cold_candidates():
    query = random.choice(SEED_QUERIES)
    try:
        results = yt.search(query, filter='songs', limit=25)
        return [s for s in (_parse_song(r) for r in results) if s]
    except Exception:
        return []


def _warm_candidates(liked_ids):
    candidates = []
    seed = random.choice(liked_ids)
    try:
        watch = yt.get_watch_playlist(videoId=seed, limit=25)
        for t in watch.get('tracks', []):
            s = _parse_song(t)
            if s and s['video_id'] != seed:
                candidates.append(s)
    except Exception:
        pass
    if len(candidates) < 10:
        candidates += _cold_candidates()
    return candidates


def get_next_song(user_id):
    db = get_db()
    liked = db.execute(
        'SELECT video_id FROM plays WHERE user_id=? AND liked=1 ORDER BY played_at DESC LIMIT 20',
        (user_id,)
    ).fetchall()
    db.close()

    liked_ids  = [r['video_id'] for r in liked]
    candidates = _warm_candidates(liked_ids) if liked_ids else _cold_candidates()

    if not candidates:
        return None

    recent  = _recently_played(user_id)
    scores  = _artist_scores(user_id)
    fresh   = [c for c in candidates if c['video_id'] not in recent] or candidates
    ranked  = sorted(fresh, key=lambda s: _score(s, scores), reverse=True)
    return ranked[0]


def record_feedback(user_id, video_id, title, artist_name, artist_id, completion, liked):
    db = get_db()
    db.execute(
        'INSERT INTO plays (user_id, video_id, title, artist_id, artist_name, completion, liked) VALUES (?,?,?,?,?,?,?)',
        (user_id, video_id, title, artist_id, artist_name, completion, 1 if liked else 0),
    )
    if artist_id:
        if liked:
            db.execute('''
                INSERT INTO artist_scores (user_id, artist_id, artist_name, like_count, skip_count)
                VALUES (?,?,?,1,0)
                ON CONFLICT(user_id, artist_id) DO UPDATE SET
                    like_count  = like_count + 1,
                    artist_name = excluded.artist_name
            ''', (user_id, artist_id, artist_name))
        else:
            db.execute('''
                INSERT INTO artist_scores (user_id, artist_id, artist_name, like_count, skip_count)
                VALUES (?,?,?,0,1)
                ON CONFLICT(user_id, artist_id) DO UPDATE SET
                    skip_count  = skip_count + 1,
                    artist_name = excluded.artist_name
            ''', (user_id, artist_id, artist_name))
    db.commit()
    db.close()
