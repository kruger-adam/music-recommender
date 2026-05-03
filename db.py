import os
import libsql_experimental as libsql


class _Cursor:
    def __init__(self, cursor):
        self._c = cursor

    def fetchone(self):
        row = self._c.fetchone()
        if row is None:
            return None
        cols = [d[0] for d in self._c.description]
        return dict(zip(cols, row))

    def fetchall(self):
        rows = self._c.fetchall()
        if not rows:
            return []
        cols = [d[0] for d in self._c.description]
        return [dict(zip(cols, r)) for r in rows]


class _Conn:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return _Cursor(self._conn.execute(sql, params))

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    url = os.getenv('TURSO_DATABASE_URL', 'music.db')
    token = os.getenv('TURSO_AUTH_TOKEN')
    conn = libsql.connect(url, auth_token=token) if token else libsql.connect(url)
    return _Conn(conn)


def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS plays (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT NOT NULL DEFAULT '',
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
            user_id     TEXT NOT NULL DEFAULT '',
            artist_id   TEXT NOT NULL,
            artist_name TEXT,
            like_count  INTEGER DEFAULT 0,
            skip_count  INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, artist_id)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_video  ON plays(video_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_plays_time   ON plays(played_at)')
    conn.commit()
    conn.close()
