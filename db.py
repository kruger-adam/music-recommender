import os
import libsql_experimental as libsql


def _dict_factory(cursor, row):
    return {col[0]: val for col, val in zip(cursor.description, row)}


def get_db():
    url = os.getenv('TURSO_DATABASE_URL', 'music.db')
    token = os.getenv('TURSO_AUTH_TOKEN')
    conn = libsql.connect(url, auth_token=token) if token else libsql.connect(url)
    conn.row_factory = _dict_factory
    return conn


def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS plays (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id    TEXT NOT NULL,
            title       TEXT,
            artist_id   TEXT,
            artist_name TEXT,
            played_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completion  REAL,
            liked       INTEGER
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS artist_scores (
            artist_id   TEXT PRIMARY KEY,
            artist_name TEXT,
            like_count  INTEGER DEFAULT 0,
            skip_count  INTEGER DEFAULT 0
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_video  ON plays(video_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_time   ON plays(played_at)')
    conn.commit()
    conn.close()
