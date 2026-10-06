from __future__ import annotations

import shutil
import time

from fastapi import HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from rq import Queue

from . import api as base
from .config import settings
from .downloader import Cancelled, analyze_url, download_media
from .redis_client import get_hash, redis_conn, rq_conn, set_hash, update_hash
from .security import new_public_id, normalize_youtube_url, privacy_hash
from .storage import storage

app = base.app


class DirectDownloadIn(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    format: str = Field(min_length=3, max_length=8)
    quality: str = Field(default="maximum", min_length=3, max_length=10)


def _now() -> str:
    return str(int(time.time()))


def _release_active(job_id: str) -> None:
    r = redis_conn()
    job = get_hash("job", job_id)
    if job.get("session_hash"):
        r.srem(f"audioera:active:session:{job['session_hash']}", job_id)
    if job.get("ip_hash"):
        r.srem(f"audioera:active:ip:{job['ip_hash']}", job_id)


@app.post("/api/download", status_code=202)
def create_direct_download(payload: DirectDownloadIn, request: Request, response: Response):
    base._disk_guard()
    _, session_hash = base._session(request, response)
    ip_hash = privacy_hash(base._client_ip(request), settings.privacy_salt)
    allowed, _ = base.rate_limit("jobs", ip_hash, settings.jobs_per_hour, 3600)
    if not allowed:
        raise HTTPException(429, "Hourly download limit reached for this network.")
    try:
        canonical = normalize_youtube_url(payload.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    kind = payload.format.lower()
    quality = payload.quality.lower()
    if kind not in base.FORMATS:
        raise HTTPException(400, "Unknown format.")
    if quality not in base.QUALITIES:
        raise HTTPException(400, "Unknown video quality.")
    if kind != "video":
        quality = "maximum"

    r = redis_conn()
    q = Queue("downloads", connection=rq_conn(), default_timeout=settings.job_timeout_seconds + 120)
    admission = r.lock("audioera:lock:download-admission", timeout=10, blocking_timeout=2)
    if not admission.acquire():
        raise HTTPException(503, "The download queue is busy. Try again shortly.")

    job_id = new_public_id("j")
    try:
        if q.count >= settings.max_queue_size:
            raise HTTPException(503, "The download queue is full. Try again shortly.")
        if base._prune_active("session", session_hash) >= settings.session_concurrent_jobs:
            raise HTTPException(429, "This browser already has the maximum number of active downloads.")
        if base._prune_active("ip", ip_hash) >= settings.ip_concurrent_jobs:
            raise HTTPException(429, "This network already has the maximum number of active downloads.")

        set_hash("job", job_id, {
            "status": "queued", "created_at": int(time.time()), "updated_at": int(time.time()),
            "stage": "Preparing", "progress": "", "url": canonical,
            "session_hash": session_hash, "ip_hash": ip_hash,
            "format": kind, "quality": quality,
        }, settings.file_ttl_seconds + settings.job_timeout_seconds)
        r.sadd(f"audioera:active:session:{session_hash}", job_id)
        r.sadd(f"audioera:active:ip:{ip_hash}", job_id)
        r.expire(f"audioera:active:session:{session_hash}", settings.job_timeout_seconds + settings.file_ttl_seconds)
        r.expire(f"audioera:active:ip:{ip_hash}", settings.job_timeout_seconds + settings.file_ttl_seconds)
        try:
            q.enqueue(
                "app.direct.direct_download_task", job_id, canonical, kind, quality,
                job_id=job_id, job_timeout=settings.job_timeout_seconds + 120,
                result_ttl=60, failure_ttl=60,
            )
        except Exception as exc:
            _release_active(job_id)
            r.delete(f"audioera:job:{job_id}")
            raise HTTPException(503, "Could not queue the download. Try again shortly.") from exc
    finally:
        try:
            admission.release()
        except Exception:
            pass

    r.incr("audioera:metric:download_submitted")
    return {"id": job_id, "status": "queued"}


def direct_download_task(job_id: str, url: str, kind: str, quality: str) -> dict:
    r = redis_conn()

    def cancelled() -> bool:
        current = get_hash("job", job_id)
        return current.get("status") == "cancelled" or bool(r.get(f"audioera:cancel:{job_id}"))

    def progress(state: str, label: str, percent: str) -> None:
        if cancelled():
            raise Cancelled("The download was cancelled.")
        update_hash(
            "job", job_id, ttl=settings.file_ttl_seconds + settings.job_timeout_seconds,
            status=state, updated_at=_now(), stage=label, progress=percent,
        )

    try:
        if cancelled():
            raise Cancelled("The download was cancelled.")
        progress("processing", "Preparing", "")

        if settings.load_test_fake_media:
            metadata = {
                "url": normalize_youtube_url(url), "video_id": "test",
                "title": "Load Test Video", "safe_title": "Load Test Video",
                "duration": 120.0, "thumbnail": "",
            }
        else:
            metadata = analyze_url(url, job_id=job_id)

        update_hash(
            "job", job_id, ttl=settings.file_ttl_seconds + settings.job_timeout_seconds,
            title=metadata["title"], duration=metadata["duration"], thumbnail=metadata["thumbnail"],
            video_id=metadata["video_id"], url=metadata["url"], updated_at=_now(),
        )
        if cancelled():
            raise Cancelled("The download was cancelled.")

        if settings.load_test_fake_media:
            progress("downloading", "Downloading", "50")
            work = settings.job_root / "work" / job_id
            work.mkdir(parents=True, exist_ok=True)
            ext = ".mp4" if kind == "video" else f".{kind}"
            final = work / ("final" + ext)
            final.write_bytes(("LOAD TEST " + job_id).encode())
            filename, details = "Load Test Video" + ext, {"synthetic": True}
        else:
            final, filename, details = download_media(
                url=metadata["url"], title=metadata["title"], duration=float(metadata["duration"]),
                kind=kind, quality=quality, job_id=job_id, progress=progress,
            )

        if cancelled():
            raise Cancelled("The download was cancelled.")
        result_storage = storage()
        key, size = result_storage.put(job_id, final, filename)
        if cancelled():
            result_storage.delete(key)
            raise Cancelled("The download was cancelled.")

        update_hash(
            "job", job_id, ttl=settings.file_ttl_seconds, status="ready", updated_at=_now(),
            ready_at=_now(), stage="Ready", progress="", file_name=filename,
            storage_key=key, output_size=size, media_details=details,
        )
        r.incr("audioera:metric:download_success")
        return {"file_name": filename, "storage_key": key, "size": size}
    except Cancelled:
        update_hash(
            "job", job_id, ttl=settings.file_ttl_seconds, status="cancelled", updated_at=_now(),
            stage="Cancelled", progress="", error="The download was cancelled.", error_category="Cancelled",
        )
        return {"cancelled": True}
    except Exception as exc:
        update_hash(
            "job", job_id, ttl=settings.file_ttl_seconds, status="failed", updated_at=_now(),
            stage="Failed", progress="", error=str(exc)[:1200], error_category=type(exc).__name__,
        )
        r.incr("audioera:metric:download_failed")
        raise
    finally:
        shutil.rmtree(settings.job_root / "work" / job_id, ignore_errors=True)
        r.delete(f"audioera:cancel:{job_id}")
        _release_active(job_id)
        r.incr("audioera:metric:jobs_processed")


def _iter_result(key: str, chunk_size: int = 1024 * 1024):
    st = storage()
    path = st.local_path(key)
    if path:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        return
    client = getattr(st, "client", None)
    bucket = getattr(st, "bucket", None)
    if client is None or not bucket:
        raise RuntimeError("Result storage is unavailable")
    obj = client.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        body.close()


@app.get("/api/jobs/{job_id}/stream")
def stream_file(job_id: str, request: Request, response: Response):
    _, session_hash = base._session(request, response)
    data = get_hash("job", job_id)
    if not data or data.get("status") != "ready" or not data.get("storage_key"):
        raise HTTPException(404, "File not found or expired.")
    if data.get("session_hash") != session_hash:
        raise HTTPException(403, "This file belongs to another browser session.")
    filename = data.get("file_name") or "download"
    size = int(data.get("output_size") or 0)
    headers = {"Cache-Control": "private, no-store", "Content-Disposition": f'attachment; filename="{filename}"'}
    if size:
        headers["Content-Length"] = str(size)
    return StreamingResponse(_iter_result(data["storage_key"]), media_type="application/octet-stream", headers=headers)
