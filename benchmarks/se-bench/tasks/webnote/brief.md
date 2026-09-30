# Build: webnote — a small self-contained web app

Build a **notes web application**: a zero-dependency Node.js HTTP server that serves a single-page app and a small JSON API, with file persistence. It must work fully offline — no CDNs, no external fonts or scripts.

## Layout (required)

- `src/server.js` — the server. Starts with `node src/server.js` (also wired as `npm start`).
- `test/` — tests runnable with `node --test`.

## Behaviour

**Server.** `node src/server.js` starts an HTTP server on `process.env.PORT || 3000`. Every response must set `Content-Type` appropriately (`text/html` for pages, `application/json` for API responses). Unknown paths return `404` with a JSON body `{"error": "not found"}` (except `/`, see below). The server must not crash on malformed requests — bad JSON in a request body returns `400` with a JSON error body.

**Page.** `GET /` returns an HTML page that:

- contains an element `<div id="app"></div>` (the mount point),
- loads its JavaScript from a **relative** path (no `http://`, `https://`, or protocol-relative `//` URLs anywhere in the HTML — no CDNs, no external anything),
- renders the existing notes when loaded and lets a user type text into a field and add it (client-side JS; any approach is fine as long as the page works by opening `/` in a browser).

**API.** All API routes are JSON:

1. `GET /api/notes` → `200`, body `{"notes": [...]}` where each note is `{"id", "text", "createdAt"}`; `id` is an integer starting at `1`, increasing by `1`, never reused; `createdAt` is an ISO 8601 string; the array is sorted by ascending `id`. Initially `{"notes": []}`.
2. `POST /api/notes` with JSON body `{"text": "..."}` → `201`, body `{"note": {...}}`. `text` must be a non-empty string after trimming, otherwise `400` with body `{"error": "text must be a non-empty string"}`.
3. `DELETE /api/notes/:id` → `204` with empty body. Unknown id → `404` with body `{"error": "no note with id <id>"}`.

**Persistence.** Notes survive restarts. The data file's location is `process.env.NOTES_FILE` when set, otherwise a `data/` file under the working directory. Writes are durable before the response is sent (a restarted server must see every note the previous instance acknowledged).

**Constraints.** Node.js built-ins only — `package.json` must have no `dependencies` (an empty object or the field absent). `npm start` must start the server. Write your own tests in `test/`. Keep the server small and readable; this is day-to-day software, not a framework exercise.
