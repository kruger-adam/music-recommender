import re
import random
from ytmusicapi import YTMusic
from db import get_db

yt = YTMusic()

LIKE_THRESHOLD = 0.80   # played ≥80% → liked
RECENT_WINDOW  = 50     # don't repeat last N played songs

SEED_QUERIES = [
    # Pop
    "80s pop hits", "90s pop hits", "2000s pop hits", "2010s pop hits",
    # Rock
    "70s classic rock", "80s rock hits", "90s alternative rock", "classic rock hits",
    # Country
    "classic country hits", "90s country hits", "2000s country hits",
    # R&B / Soul
    "motown hits", "70s soul hits", "90s r&b hits", "2000s r&b hits",
    # Hip-hop
    "90s hip hop hits", "2000s hip hop hits", "classic rap hits",
    # Electronic / Dance
    "90s dance hits", "2000s euro dance hits", "classic edm hits",
    # Other
    "80s new wave hits", "60s hits", "jazz standards", "classic blues hits",
    "reggae hits", "latin pop hits", "folk hits",
]

COLD_INJECT_RATE = 0.20  # 1 in 5 songs explores a new genre

SEED_LABELS = {
    'pop_80s': '80s Pop',          'pop_90s': '90s Pop',           'pop_2000s': '2000s Pop',      'pop_indie': 'Indie Pop',
    'rock_classic': 'Classic Rock', 'rock_80s': '80s Rock',         'rock_alternative': 'Alt Rock', 'rock_hard': 'Hard Rock',      'rock_indie': 'Indie Rock',
    'country_classic': 'Classic Country', 'country_90s': '90s Country', 'country_pop': 'Country Pop', 'country_new': 'New Country',  'country_bluegrass': 'Bluegrass',
    'rnb_motown': 'Motown',        'rnb_soul': '70s Soul',          'rnb_90s': '90s R&B',          'rnb_2000s': '2000s R&B',
    'hiphop_90s': '90s Hip-Hop',   'hiphop_2000s': '2000s Hip-Hop', 'hiphop_trap': 'Trap',         'hiphop_oldschool': 'Old School Rap',
    'electronic_90s': '90s Dance', 'electronic_euro': 'Euro Dance', 'electronic_edm': 'EDM',       'electronic_house': 'House',   'electronic_synth': 'Synthwave',
    'jazz_standards': 'Jazz Standards', 'jazz_smooth': 'Smooth Jazz', 'jazz_bebop': 'Bebop',       'jazz_swing': 'Swing',
    'folk_classic': 'Folk',        'folk_americana': 'Americana',   'folk_singersong': 'Singer-Songwriter',
    'latin_pop': 'Latin Pop',      'latin_reggaeton': 'Reggaeton',  'latin_salsa': 'Salsa',        'latin_bossa': 'Bossa Nova',
    'reggae_classic': 'Reggae',    'reggae_ska': 'Ska',             'reggae_dancehall': 'Dancehall',
    'more_energy': 'More Energy',  'less_energy': 'Less Energy',
}


def _format_query(q):
    q = re.sub(r'\s+(hits|music)\s*$', '', q, flags=re.IGNORECASE).strip()
    return ' '.join(w if w[0].isdigit() else w.capitalize() for w in q.split())


GENRE_SEEDS = {
    # Pop
    'pop_80s':            ['80s pop hits'],
    'pop_90s':            ['90s pop hits'],
    'pop_2000s':          ['2000s pop hits'],
    'pop_indie':          ['indie pop hits'],
    # Rock
    'rock_classic':       ['classic rock hits', '70s classic rock'],
    'rock_80s':           ['80s rock hits'],
    'rock_alternative':   ['90s alternative rock'],
    'rock_hard':          ['hard rock hits'],
    'rock_indie':         ['indie rock hits'],
    # Country
    'country_classic':    ['classic country hits'],
    'country_90s':        ['90s country hits'],
    'country_pop':        ['country pop hits'],
    'country_new':        ['new country hits Zach Bryan Morgan Wallen'],
    'country_bluegrass':  ['bluegrass hits'],
    # R&B
    'rnb_motown':         ['motown hits'],
    'rnb_soul':           ['70s soul hits'],
    'rnb_90s':            ['90s r&b hits'],
    'rnb_2000s':          ['2000s r&b hits'],
    # Hip-hop
    'hiphop_90s':         ['90s hip hop hits'],
    'hiphop_2000s':       ['2000s hip hop hits'],
    'hiphop_trap':        ['trap music hits'],
    'hiphop_oldschool':   ['old school rap hits'],
    # Electronic
    'electronic_90s':     ['90s dance hits'],
    'electronic_euro':    ['2000s euro dance hits'],
    'electronic_edm':     ['classic edm hits'],
    'electronic_house':   ['house music hits'],
    'electronic_synth':   ['synthwave hits'],
    # Jazz
    'jazz_standards':     ['jazz standards'],
    'jazz_smooth':        ['smooth jazz hits'],
    'jazz_bebop':         ['bebop jazz'],
    'jazz_swing':         ['swing jazz hits'],
    # Folk
    'folk_classic':       ['folk hits'],
    'folk_americana':     ['americana music hits'],
    'folk_singersong':    ['singer songwriter hits'],
    # Latin
    'latin_pop':          ['latin pop hits'],
    'latin_reggaeton':    ['reggaeton hits'],
    'latin_salsa':        ['salsa hits'],
    'latin_bossa':        ['bossa nova hits'],
    # Reggae
    'reggae_classic':     ['reggae hits'],
    'reggae_ska':         ['ska hits'],
    'reggae_dancehall':   ['dancehall hits'],
    # Energy (from not_mood)
    'more_energy':        ['2000s dance pop hits', '90s dance hits', '80s rock hits', '2000s euro dance hits'],
    'less_energy':        ['jazz standards', 'folk hits', '70s soul hits', 'classic blues hits'],
}


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


def _cold_candidates(query=None):
    query = query or random.choice(SEED_QUERIES)
    try:
        results = yt.search(query, filter='songs', limit=25)
        return [s for s in (_parse_song(r) for r in results) if s]
    except Exception:
        return []


def _warm_candidates(seed_songs):
    candidates = []
    seen = set()
    seeds = random.sample(seed_songs, min(3, len(seed_songs)))
    for seed in seeds:
        try:
            watch = yt.get_watch_playlist(videoId=seed['video_id'], limit=25)
            for t in watch.get('tracks', []):
                s = _parse_song(t)
                if s and s['video_id'] not in seen:
                    seen.add(s['video_id'])
                    candidates.append(s)
        except Exception:
            pass
    if len(candidates) < 10:
        candidates += _cold_candidates()
    return candidates, seeds


def get_next_song(user_id, seed=None, artist=None, requested=False):
    db = get_db()
    superliked = db.execute(
        'SELECT video_id, title, artist_name, artist_id FROM plays WHERE user_id=? AND superliked=1 ORDER BY played_at DESC LIMIT 10',
        (user_id,)
    ).fetchall()
    liked = db.execute(
        'SELECT video_id, title, artist_name, artist_id FROM plays WHERE user_id=? AND liked=1 ORDER BY played_at DESC LIMIT 20',
        (user_id,)
    ).fetchall()
    db.close()

    superliked_songs = [dict(r) for r in superliked]
    liked_songs      = [dict(r) for r in liked]
    superliked_ids   = {r['video_id'] for r in superliked_songs}
    seed_songs       = superliked_songs if superliked_songs else liked_songs
    seed_ids         = [r['video_id'] for r in seed_songs]

    used_seed = None

    if artist:
        try:
            results = yt.search(artist, filter='songs', limit=25)
            candidates = [s for s in (_parse_song(r) for r in results) if s]
        except Exception:
            candidates = []
        if not candidates:
            candidates = _cold_candidates()
        reason = f'Playing: {artist}'
    elif seed and seed in GENRE_SEEDS:
        candidates = _cold_candidates(random.choice(GENRE_SEEDS[seed]))
        if requested:
            if seed == 'more_energy':
                reason = 'You wanted more energy'
            elif seed == 'less_energy':
                reason = 'You wanted something calmer'
            else:
                reason = f'You asked for: {SEED_LABELS.get(seed, seed)}'
        else:
            reason = f'Genre: {SEED_LABELS.get(seed, seed)}'
    elif not seed_ids or random.random() < COLD_INJECT_RATE:
        q = random.choice(SEED_QUERIES)
        candidates = _cold_candidates(q)
        if not candidates and seed_songs:
            candidates, _ = _warm_candidates(seed_songs)
        reason = f'Mixing it up · {_format_query(q)}'
    else:
        candidates, used_seeds = _warm_candidates(seed_songs)
        used_seed = used_seeds[0] if used_seeds else None
        if used_seed:
            verb = 'loved' if used_seed['video_id'] in superliked_ids else 'liked'
            reason = f"Because you {verb}: {used_seed['title']} · {used_seed['artist_name']}"
        else:
            reason = "Similar to songs you've liked"

    if not candidates:
        return None

    recent = _recently_played(user_id)
    scores = _artist_scores(user_id)
    fresh  = [c for c in candidates if c['video_id'] not in recent] or candidates
    ranked = sorted(fresh, key=lambda s: _score(s, scores), reverse=True)
    song   = ranked[0]

    picked_artist_id = song.get('artist_id')

    # Introducing: flag genuinely new artists once we have enough history
    if picked_artist_id and picked_artist_id not in scores and len(scores) >= 3 and not artist:
        reason = f'Introducing: {song["artist_name"]}'
    elif picked_artist_id and picked_artist_id in scores and not artist:
        # Append artist affinity count when it's significant and not implied by the seed
        like_count = round(scores[picked_artist_id][0])
        seed_artist_id = used_seed.get('artist_id') if used_seed else None
        if like_count >= 3 and picked_artist_id != seed_artist_id:
            reason += f' · you\'ve liked {song["artist_name"]} {like_count}×'

    song['reason']     = reason
    song['superliked'] = song['video_id'] in superliked_ids
    return song


def record_feedback(user_id, video_id, title, artist_name, artist_id, completion, liked, superliked=False):
    db = get_db()
    db.execute(
        'INSERT INTO plays (user_id, video_id, title, artist_id, artist_name, completion, liked, superliked) VALUES (?,?,?,?,?,?,?,?)',
        (user_id, video_id, title, artist_id, artist_name, completion, 1 if liked else 0, 1 if superliked else 0),
    )
    if artist_id:
        if superliked:
            db.execute('''
                INSERT INTO artist_scores (user_id, artist_id, artist_name, like_count, skip_count)
                VALUES (?,?,?,4,0)
                ON CONFLICT(user_id, artist_id) DO UPDATE SET
                    like_count  = like_count + 4,
                    artist_name = excluded.artist_name
            ''', (user_id, artist_id, artist_name))
        else:
            like_weight = round(completion, 4)
            skip_weight = round(1.0 - completion, 4)
            db.execute('''
                INSERT INTO artist_scores (user_id, artist_id, artist_name, like_count, skip_count)
                VALUES (?,?,?,?,?)
                ON CONFLICT(user_id, artist_id) DO UPDATE SET
                    like_count  = like_count + ?,
                    skip_count  = skip_count + ?,
                    artist_name = excluded.artist_name
            ''', (user_id, artist_id, artist_name, like_weight, skip_weight, like_weight, skip_weight))
    db.commit()
    db.close()
