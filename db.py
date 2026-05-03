import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'music.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS plays (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id    TEXT NOT NULL,
            title       TEXT,
            artist_id   TEXT,
            artist_name TEXT,
            played_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completion  REAL,
            liked       INTEGER
        );
        CREATE TABLE IF NOT EXISTS artist_scores (
            artist_id   TEXT PRIMARY KEY,
            artist_name TEXT,
            like_count  INTEGER DEFAULT 0,
            skip_count  INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_plays_video  ON plays(video_id);
        CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_id);
        CREATE INDEX IF NOT EXISTS idx_plays_time   ON plays(played_at);
    ''')
    conn.commit()
    conn.close()
