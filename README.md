# Smart Shuffle

A self-learning YouTube Music player. Skip a song to train it away; let one play to train it toward you. Gets better over time.

**Live:** [smart-shuffle.vercel.app](https://smart-shuffle.vercel.app)

## How it works

- Fetches songs from YouTube Music via `ytmusicapi`
- Tracks every play, skip, and like in a Turso (SQLite) database
- Scores artists based on like/skip history and weights future picks accordingly
- Cold-starts with curated seed queries; switches to watch-playlist recommendations once you have liked songs

## Stack

- **Backend:** Python / Flask, deployed as Vercel serverless functions
- **Database:** Turso (libSQL) — persists your taste across sessions
- **Music source:** YouTube Music (no API key required)

## Local development

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:5001
```

Uses a local `music.db` SQLite file when `TURSO_DATABASE_URL` is not set.

## Deployment

Deployed on Vercel. Two environment variables required:

| Variable | Description |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://...` URL from Turso |
| `TURSO_AUTH_TOKEN` | Auth token from `turso db tokens create <db>` |
