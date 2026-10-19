---
name: loom
description: Watch a Loom video the user shared. Use whenever a loom.com/share or loom.com/embed link appears in the conversation, or the user asks about "the Loom", a screen recording, or a video walkthrough they linked.
---

# Watching Loom videos

When the user shares a Loom link, watch it before answering. Don't ask whether to.

1. Call `loom_overview` with the link. It returns the title, Loom's summary, and the timestamped transcript interleaved with key frames taken wherever the screen changed. The first call on a new video takes 20-60 seconds; tell the user you're watching it.
2. Answer from both the words and the frames. Screen recordings often say "click this" or "see this error" with the thing only visible on screen.
3. Go deeper only when needed:
   - `loom_moment(url, start, end)`: denser frames for one stretch, e.g. where a bug reproduces or a quick UI sequence happens.
   - `loom_frame(url, t)`: one full-resolution frame, to read small text, code, stack traces, or URLs.
   - `loom_transcript(url, start, end)`: words only, or the rest of a long transcript that `loom_overview` truncated.

When the transcript and the screen disagree (speech-to-text mishears names, labels, and code), trust the screen and say so. Cite timestamps like [1:42] when you refer to a moment, so the user can jump to it.

Only public share links work. If the tool says the video isn't public, ask the user to change its sharing setting or paste the transcript.
