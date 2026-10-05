FROM python:3.13.13-slim-bookworm
ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6
ARG DENO_VERSION=2.9.7
ARG TARGETARCH
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates unzip tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
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
    && pip install --upgrade pip \
    && pip install -r requirements.txt \
    && mkdir -p /tmp/audioera-jobs \
    && chown -R nobody:nogroup /app /tmp/audioera-jobs
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["uvicorn","app.api:app","--host","0.0.0.0","--port","8080","--workers","2","--proxy-headers"]
