# loom-context

Let Claude Code watch Loom videos. Paste a public `loom.com/share/...` link and Claude gets the transcript **and** the key frames, so it can see the button, the error, or the UI state the speaker is pointing at instead of guessing from words alone.

It's a remote MCP server on Cloudflare. Nothing to install locally, and no API keys: your own Claude session does the looking.

## Install

As a Claude Code plugin (MCP server + a skill that auto-triggers on Loom links):

```
/plugin marketplace add Samama251251/loom-context
/plugin install loom@loom-context
```

Or just the MCP server:

```
claude mcp add --transport http loom https://loom-context.samama251251.workers.dev/mcp
```

## Tools

| Tool | Returns |
|---|---|
| `loom_overview(url, frames=10)` | Title, Loom's summary, full transcript interleaved with key frames chosen where the screen changed |
| `loom_moment(url, start, end, frames=6)` | Denser frames + transcript for one time range |
| `loom_frame(url, t, width=1568)` | One full-resolution frame (small text, code, errors) |
| `loom_transcript(url, start?, end?)` | Transcript only, fast |

Times accept seconds (`102`) or timestamps (`"1:42"`).

## How it works

```
Claude Code ──MCP──▶ Worker (src/index.ts)
                       ├─ oEmbed + GraphQL ─▶ title, summary, transcript   (src/loom.ts)
                       ├─ R2 cache (24h)
                       └─ Container per video (container/server.py)
                            yt-dlp video-only download → 2 fps grayscale candidates
                            → changed-cell detection on a 32×18 grid, ignoring cells that flicker
                              constantly (webcam bubble) → wait for the screen to settle
                            → skip anything matching the last 4 kept frames → budget by change size
```

Frames are matched to transcript lines on the server: each frame is followed by the words spoken while it was on screen.

Limits: public videos only, 45 minutes max, 10 new videos per minute per IP.

## Develop

Requires Docker (for the container image) and a Cloudflare account on the Workers Paid plan (Containers).

```
npm install
npx wrangler r2 bucket create loom-context-cache   # once
npm run typecheck
npm run deploy
```

Test the extractor alone:

```
docker build --platform linux/amd64 -t loom-extractor container
docker run --rm -p 8081:8080 loom-extractor
curl "localhost:8081/frames?id=<32-char loom id>&count=10"
```

## Caveats

Transcripts come from Loom's internal, undocumented GraphQL API, and downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp). Both break when Loom changes things; `yt-dlp` is pinned in `container/Dockerfile` so upgrades are deliberate. Loom's terms restrict use of non-public APIs, so this project only touches public share links.
