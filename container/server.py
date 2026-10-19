"""Frame extraction service for loom-context.

Runs inside a Cloudflare Container, one instance per Loom video. Downloads the
video once (video stream only: the transcript comes from Loom, so audio is
dead weight), then serves key frames, frames for a time range, or a single
frame from the local copy.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image

CACHE_DIR = "/tmp/loom-cache"
MAX_DURATION_S = 45 * 60
LOOM_ID = re.compile(r"^[0-9a-f]{32}$")

# Change detection works on a coarse grayscale grid of each candidate frame.
GRID_W, GRID_H = 32, 18
CELL_DELTA = 18  # 0-255 brightness change for a grid cell to count as "changed"
MIN_CHANGED_FRACTION = 0.015  # of non-volatile cells; ~9 cells catches toasts and dialogs
VOLATILE_FRACTION = 0.35  # cells changing this often are webcam bubbles or playing video
COMPARE_WINDOW = 4  # compare against the last N kept frames, so A-B-A switching isn't re-sent

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class ExtractError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _lock_for(video_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(video_id, threading.Lock())


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ensure_video(video_id: str) -> tuple[str, dict]:
    """Download the video once per container lifetime; concurrent callers wait on the same download."""
    folder = os.path.join(CACHE_DIR, video_id)
    meta_path = os.path.join(folder, "meta.json")
    with _lock_for(video_id):
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)
            return os.path.join(folder, meta["file"]), meta

        url = f"https://www.loom.com/share/{video_id}"
        probe = _run(["yt-dlp", "-J", "--no-warnings", url], 60)
        if probe.returncode != 0:
            raise ExtractError(502, f"yt-dlp could not read this Loom (is it public?): {probe.stderr[-400:]}")
        info = json.loads(probe.stdout)
        duration = float(info.get("duration") or 0)
        if duration > MAX_DURATION_S:
            raise ExtractError(422, f"video is {duration / 60:.0f} min; the limit is {MAX_DURATION_S // 60} min")

        tmp = tempfile.mkdtemp(dir=CACHE_DIR)
        t0 = time.time()
        dl = _run([
            "yt-dlp", "-N", "8", "--no-warnings", "--max-filesize", "500M",
            "-f", "bv[height<=720]/bv*[height<=720]/b[height<=720]/bv/b",
            "-o", os.path.join(tmp, "video.%(ext)s"), url,
        ], 600)
        files = [f for f in os.listdir(tmp) if f.startswith("video.")]
        if dl.returncode != 0 or not files:
            shutil.rmtree(tmp, ignore_errors=True)
            raise ExtractError(502, f"download failed: {dl.stderr[-400:]}")

        meta = {"file": files[0], "duration": duration, "download_secs": round(time.time() - t0, 1)}
        with open(os.path.join(tmp, "meta.json"), "w") as f:
            json.dump(meta, f)
        shutil.rmtree(folder, ignore_errors=True)
        os.rename(tmp, folder)
        return os.path.join(folder, meta["file"]), meta


def _candidates(video: str, start: float, end: float, fps: float, workdir: str) -> list[tuple[float, list[int]]]:
    """Decode small grayscale candidates; returns (timestamp, grid) pairs."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{end - start:.3f}",
           "-vf", f"fps={fps},scale=256:-2,format=gray", "-q:v", "6", os.path.join(workdir, "c%05d.jpg")]
    p = _run(cmd, 600)
    if p.returncode != 0:
        raise ExtractError(500, f"ffmpeg candidate decode failed: {p.stderr[-400:]}")
    out = []
    for i, name in enumerate(sorted(os.listdir(workdir))):
        with Image.open(os.path.join(workdir, name)) as im:
            grid = im.convert("L").resize((GRID_W, GRID_H), Image.BOX)
            out.append((start + i / fps, list(grid.getdata())))
    return out


def _changed(a: list[int], b: list[int], mask: list[bool]) -> int:
    return sum(1 for x, y, m in zip(a, b, mask) if m and abs(x - y) > CELL_DELTA)


def select_frames(cands: list[tuple[float, list[int]]], budget: int) -> list[float]:
    """Pick timestamps where the screen meaningfully changed, settled, and wasn't seen recently."""
    if not cands:
        return []
    n_cells = GRID_W * GRID_H
    # Cells that flicker between most consecutive candidates are a webcam bubble or embedded video;
    # ignoring them stops a talking face from eating the whole frame budget.
    flips = [0] * n_cells
    for (_, a), (_, b) in zip(cands, cands[1:]):
        for k in range(n_cells):
            if abs(a[k] - b[k]) > CELL_DELTA:
                flips[k] += 1
    pairs = max(1, len(cands) - 1)
    mask = [f / pairs < VOLATILE_FRACTION for f in flips]
    stable_cells = max(1, sum(mask))
    threshold = max(3, int(stable_cells * MIN_CHANGED_FRACTION))

    kept: list[tuple[float, list[int], int]] = [(cands[0][0], cands[0][1], stable_cells)]
    i = 1
    while i < len(cands):
        t, grid = cands[i]
        novelty = min(_changed(grid, g, mask) for _, g, _ in kept[-COMPARE_WINDOW:])
        if novelty >= threshold:
            # Mid-scroll and mid-transition frames are blurry; step forward until the screen settles.
            j = i
            while j + 1 < len(cands) and j - i < 4 and _changed(cands[j][1], cands[j + 1][1], mask) >= threshold:
                j += 1
            kept.append((cands[j][0], cands[j][1], novelty))
            i = j + 1
        else:
            i += 1

    if len(kept) <= budget:
        return [t for t, _, _ in kept]
    # Over budget: keep the opening frame plus the biggest changes, spread out in time.
    span = cands[-1][0] - cands[0][0]
    min_gap = span / (budget * 3) if span > 0 else 0
    chosen = [kept[0]]
    for item in sorted(kept[1:], key=lambda k: -k[2]):
        if len(chosen) >= budget:
            break
        if all(abs(item[0] - c[0]) >= min_gap for c in chosen):
            chosen.append(item)
    return sorted(t for t, _, _ in chosen)


def render(video: str, t: float, width: int) -> str:
    """Full-quality JPEG at timestamp t, base64-encoded."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", dir=CACHE_DIR) as out:
        p = _run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
                  "-vf", f"scale='min({width},iw)':-2", "-q:v", "4", out.name], 60)
        if p.returncode != 0 or os.path.getsize(out.name) == 0:
            raise ExtractError(500, f"ffmpeg frame render failed at {t:.1f}s: {p.stderr[-300:]}")
        with open(out.name, "rb") as f:
            return base64.b64encode(f.read()).decode()


def key_frames(video_id: str, start: float | None, end: float | None, budget: int, width: int) -> dict:
    video, meta = ensure_video(video_id)
    duration = meta["duration"] or 0
    lo = max(0.0, start or 0.0)
    hi = min(duration, end) if end is not None and duration else (end or duration)
    if hi <= lo:
        raise ExtractError(400, f"empty time range {lo:.1f}-{hi:.1f}s (video is {duration:.1f}s)")
    # 2 fps catches quick UI changes; long videos drop to 1 fps to bound decode time.
    fps = 2 if hi - lo <= 600 else 1
    t0 = time.time()
    with tempfile.TemporaryDirectory(dir=CACHE_DIR) as work:
        cands = _candidates(video, lo, hi, fps, work)
    picks = select_frames(cands, budget)
    frames = [{"t": round(t, 2), "jpeg_base64": render(video, t, width)} for t in picks]
    return {
        "duration": duration,
        "frames": frames,
        "stats": {"candidates": len(cands), "download_secs": meta["download_secs"], "select_secs": round(time.time() - t0, 1)},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path.split('?')[0]} {fmt % args}")

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/health":
                return self._send(200, {"ok": True})
            video_id = q.get("id", "")
            if not LOOM_ID.match(video_id):
                raise ExtractError(400, "id must be a 32-character Loom video id")
            width = min(2000, max(200, int(q.get("width", 1024))))
            if u.path == "/frames":
                start = float(q["start"]) if "start" in q else None
                end = float(q["end"]) if "end" in q else None
                budget = min(24, max(1, int(q.get("count", 10))))
                return self._send(200, key_frames(video_id, start, end, budget, width))
            if u.path == "/frame":
                video, meta = ensure_video(video_id)
                t = min(max(0.0, float(q.get("t", 0))), max(0.0, meta["duration"] - 0.1))
                return self._send(200, {"duration": meta["duration"], "frames": [{"t": t, "jpeg_base64": render(video, t, width)}]})
            raise ExtractError(404, "unknown route")
        except ExtractError as e:
            self._send(e.status, {"error": str(e)})
        except subprocess.TimeoutExpired as e:
            self._send(504, {"error": f"timed out: {e.cmd[0]}"})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": f"bad parameter: {e}"})
        except Exception as e:
            self._send(500, {"error": f"internal error: {e!r}"})
            raise


if __name__ == "__main__":
    os.makedirs(CACHE_DIR, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
