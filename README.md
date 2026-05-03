# Smart Shuffle

A self-learning YouTube Music player. The more you use it, the better it knows your taste.

**Live:** [smart-shuffle.vercel.app](https://smart-shuffle.vercel.app)

## How it works

- Fetches songs from YouTube Music via `ytmusicapi`
- Tracks every play in a Turso (SQLite) database, recording how much of each song you listened to
- Scores artists using a graded completion signal — skipping at 5% vs 75% are treated differently; letting a song play through scores highest
- Superliking a song (♥) gives the artist a 4x stronger boost and seeds future recommendations from that song first
- After skipping, an optional chip row lets you tag why (Wrong genre / Not this artist / Not the mood / Overplayed) — stored for future algorithm improvements
- Cold-starts with curated seed queries; once you have liked songs, pulls candidates from up to 3 liked songs' YouTube watch-next playlists simultaneously, then re-ranks by your artist scores

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
