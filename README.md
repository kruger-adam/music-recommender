# Smart Shuffle

A self-learning YouTube Music player. The more you use it, the better it knows your taste.

**Live:** [smart-shuffle.vercel.app](https://smart-shuffle.vercel.app)

## How it works

- Fetches songs from YouTube Music via `ytmusicapi`
- Tracks every play in a Turso (SQLite) database, recording how much of each song you listened to
- Scores artists using a graded completion signal — skipping at 5% vs 75% are treated differently; letting a song play through scores highest
- Superliking a song (♥) gives the artist a 4x stronger boost and seeds future recommendations from that song first
- After skipping, an optional chip row lets you tag why (Wrong genre / Not this artist / Not the mood / Overplayed) — stored for future algorithm improvements
- Cold-starts with curated seed queries spanning 90s–2000s pop, classic rock, country, r&b, and indie; once you have liked songs, pulls candidates from YouTube watch-next playlists — with a 20% random genre injection on every request to prevent taste bubbles
- Every song shows a reason line explaining why it was picked: which liked song seeded it, which genre is being explored, or when an artist you haven't heard before is being introduced
- Search (🔍) lets you jump straight to a specific song, with a live autocomplete dropdown as you type. Picking a search result plays it immediately and feeds the algorithm: searching for a song is treated as a strong taste signal for that artist (a floor on the like weight), while an early skip afterward counts far less against it than skipping a recommendation would — and the song is eligible to seed future recommendations even if you didn't listen long enough for it to count as "liked"
- The last-played song is saved to localStorage — refreshing mid-song shows a "Resume" button that restarts it; the offer clears once you skip or finish the song

## Auth

Sign-in is email-based — no passwords. Enter your email, get a 6-digit code, type it into the app. Works from any context (including home screen web apps on iOS, which can't share cookies with Safari). Your profile is tied to your email so it syncs across devices automatically.

## Stack

- **Backend:** Python / Flask, deployed as Vercel serverless functions
- **Database:** Turso (libSQL) — persists your taste across sessions
- **Music source:** YouTube Music (no API key required)
- **Auth:** 6-digit code emails via Gmail SMTP, JWT stored in localStorage

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/send-link` | Send a 6-digit login code to an email address |
| `POST` | `/auth/verify-code` | Verify a 6-digit code and return a JWT |
| `GET` | `/auth/me` | Return the current user ID (Bearer token or cookie) |
| `POST` | `/auth/logout` | Clear the auth cookie |
| `GET` | `/api/next` | Get the next recommended song (`seed`, `artist`, `requested=1`, `exclude` params optional) |
| `GET` | `/api/search` | Search for a song by title/artist (`q` param) — powers the autocomplete dropdown |
| `POST` | `/api/feedback` | Record play completion and like/skip |
| `POST` | `/api/superlike` | Superlike the current song |
| `POST` | `/api/skip-reason` | Tag why a song was skipped |
| `GET` | `/api/stats` | Get play/like counts for current user |
| `GET` | `/api/trend` | Get like-rate trend buckets |
| `GET` | `/api/similar-artists` | Get artists similar to a given track |

## Local development

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:5001
```

Uses a local `music.db` SQLite file when `TURSO_DATABASE_URL` is not set.

## Deployment

Deployed on Vercel. Environment variables required:

| Variable | Description |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://...` URL from Turso |
| `TURSO_AUTH_TOKEN` | Auth token from `turso db tokens create <db>` |
| `JWT_SECRET` | Random secret for signing auth cookies |
| `GMAIL_APP_PASSWORD` | Google App Password for sending magic link emails |
