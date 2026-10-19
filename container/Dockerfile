FROM python:3.12-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: Loom's internal API drifts, so upgrade yt-dlp deliberately and re-run the smoke test.
RUN pip install --no-cache-dir "yt-dlp==2026.8.19" "pillow==11.3.0"

WORKDIR /app
COPY server.py .
EXPOSE 8080
CMD ["python", "-u", "server.py"]
