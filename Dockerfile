FROM python:3.13.13-slim-bookworm
ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6
ARG BGUTIL_VERSION=2.0.0
ARG BGUTIL_SHA256=bce874dfa25896c2798e0f4f8147b7b22e785479eb1e459ab232bf2506c95016
ARG DENO_VERSION=2.9.7
ARG TARGETARCH
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates unzip tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && mkdir -p /usr/local/share/yt-dlp-plugins \
    && curl -fsSL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip" -o /usr/local/share/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip \
    && echo "${BGUTIL_SHA256}  /usr/local/share/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip" | sha256sum -c - \
    && DOCKER_ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "${DOCKER_ARCH}" in \
         amd64) DENO_TARGET="x86_64-unknown-linux-gnu" ;; \
         arm64) DENO_TARGET="aarch64-unknown-linux-gnu" ;; \
         *) echo "Unsupported Docker architecture for Deno: ${DOCKER_ARCH}" >&2; exit 1 ;; \
       esac \
    && DENO_ASSET="deno-${DENO_TARGET}.zip" \
    && cd /tmp \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${DENO_ASSET}" -o "${DENO_ASSET}" \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${DENO_ASSET}.sha256sum" -o "${DENO_ASSET}.sha256sum" \
    && sha256sum -c "${DENO_ASSET}.sha256sum" \
    && unzip -q "${DENO_ASSET}" -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/deno \
    && rm -f "${DENO_ASSET}" "${DENO_ASSET}.sha256sum" \
    && /usr/local/bin/deno --version \
    && /usr/local/bin/yt-dlp --version
WORKDIR /app
COPY bundle/ /tmp/bundle/
RUN cat /tmp/bundle/part*.txt | base64 -d > /tmp/source.tar.gz \
    && tar -xzf /tmp/source.tar.gz -C /app \
    && rm -rf /tmp/source.tar.gz /tmp/bundle \
    && sed -i 's/"process": _process_name(args)/"process_name": _process_name(args)/g; s/"process": "yt-dlp"/"process_name": "yt-dlp"/g' /app/app/downloader.py \
    && sed -i '/"--js-runtimes", f"{runtime_name}:{runtime_exec}",/a\        "--remote-components", "ejs:github",' /app/app/downloader.py \
    && python -c 'from pathlib import Path; p=Path("/app/app/downloader.py"); s=p.read_text(); old="    if settings.yt_dlp_extractor_args:\n        args += [\"--extractor-args\", settings.yt_dlp_extractor_args]\n"; new="    if settings.yt_dlp_extractor_args:\n        for extractor_arg in settings.yt_dlp_extractor_args.split(\"||\"):\n            extractor_arg = extractor_arg.strip()\n            if extractor_arg:\n                args += [\"--extractor-args\", extractor_arg]\n"; assert old in s; p.write_text(s.replace(old,new))' \
    && sed -i 's/"processing_time", "process", "exit_status"/"processing_time", "process_name", "exit_status"/g' /app/app/logging_json.py \
    && sed -i '/^import signal$/a import socket' /app/app/worker_runner.py \
    && sed -i 's/name=f"{queue_name}-{os.getpid()}"/name=f"{queue_name}-{socket.gethostname()}-{os.getpid()}"/g' /app/app/worker_runner.py \
    && python -m compileall -q /app/app \
    && pip install --upgrade pip \
    && pip install -r requirements.txt \
    && mkdir -p /tmp/audioera-jobs \
    && chown -R nobody:nogroup /app /tmp/audioera-jobs
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["uvicorn","app.api:app","--host","0.0.0.0","--port","8080","--workers","2","--proxy-headers"]
