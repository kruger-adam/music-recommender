# music-recommender

## Querying the database

Credentials are in `.env.local` (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`).

Use `https://` when constructing the client URL — `libsql://` triggers WebSockets which fail locally:

```python
import libsql_client, asyncio, os

async def query():
    client = libsql_client.create_client(
        url=os.environ['TURSO_DATABASE_URL'].replace('libsql://', 'https://'),
        auth_token=os.environ['TURSO_AUTH_TOKEN']
    )
    r = await client.execute("SELECT ...")
    for row in r.rows: print(row)
    await client.close()

asyncio.run(query())
```

Install if missing: `pip3 install libsql-client`

## Before every commit

Check whether README.md needs updating. Update it if any of the following changed:
- How the recommendation algorithm works
- New user-facing features or controls
- New API endpoints
- Stack or deployment changes
