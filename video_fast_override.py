from __future__ import annotations

import json
import math
import queue
import re
import threading
import time
from pathlib import Path

from . import downloader as dl
from .config import settings
from .downloader import Cancelled
from .redis_client import redis_conn
from .security import normalize_youtube_url, safe_filename, safe_thumbnail


def _video_source_and_metadata(url: str, quality: str, job_id: str, stage: Path, progress, deadline: float) -> tuple[Path, dict, dict]:
    selector = {
        "low": "bestvideo[vcodec^=avc1][height<=480]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1][height<=480]+bestaudio/best[height<=480][ext=mp4]/best[height<=480]/best",
        "medium": "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1][height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best",
        "maximum": "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4][vcodec^=avc1]/bestvideo+bestaudio/best",
    }[quality]
    cmd = [
        settings.yt_dlp_path,
        "--ignore-config", "--no-playlist", "--no-overwrites", "--no-colors",
        "--socket-timeout", "30", "--retries", "3",
        "--cache-dir", "/tmp/yt-dlp-cache",
        "--plugin-dirs", "/usr/local/share/yt-dlp-plugins",
        "--js-runtimes", f"deno:{settings.js_runtime_path}",
        "--remote-components", "ejs:github",
        "--extractor-args", "youtube:player_client=mweb;player_skip=webpage;fetch_pot=always;formats=missing_pot",
        "--extractor-args", "youtubepot-bgutilhttp:base_url=http://bgutil-provider.railway.internal:4416",
        "-f", selector,
        "--merge-output-format", "mkv",
        "--max-filesize", str(settings.max_source_file_size_bytes),
        "--match-filter", f"!is_live & duration <= {settings.max_duration_seconds}",
        "--write-info-json", "--no-write-playlist-metafiles", "--no-write-comments",
        "--newline", "--progress",
        "--progress-template", "download:PROGRESS %(progress._percent_str)s",
        "-o", str(stage / "source.%(ext)s"),
        "--", url,
    ]
    proc = dl._popen([str(x) for x in cmd])
    out_q: queue.Queue[str] = queue.Queue()
    stderr_parts: list[str] = []
    stdout_done = threading.Event()
    stderr_done = threading.Event()

    def read_stdout() -> None:
        try:
            if proc.stdout:
                for line in proc.stdout:
                    out_q.put(line)
        finally:
            stdout_done.set()

    def read_stderr() -> None:
        try:
            if proc.stderr:
                tail = ""
                while True:
                    chunk = proc.stderr.read(4096)
                    if not chunk:
                        break
                    tail = (tail + chunk)[-32768:]
                stderr_parts.append(tail)
        finally:
            stderr_done.set()

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()
    try:
        while True:
            if redis_conn().get(f"audioera:cancel:{job_id}"):
                dl._stop(proc)
                raise Cancelled("The operation was cancelled.")
            if time.monotonic() >= deadline:
                dl._stop(proc)
                raise dl.DownloadError("Job processing timeout exceeded.")
            try:
                line = out_q.get(timeout=0.2)
            except queue.Empty:
                line = ""
            if line.startswith("PROGRESS "):
                pct = line[9:].strip().replace("%", "").strip()
                if re.fullmatch(r"\d+(?:\.\d+)?", pct):
                    progress("downloading", "Downloading video", pct)
            if proc.poll() is not None and stdout_done.is_set() and out_q.empty():
                break
        stderr_done.wait(2)
        stderr = "".join(stderr_parts)
        exit_code = int(proc.returncode or 0)
        dl.log.info("process_exit", extra={"job_id": job_id, "process_name": "yt-dlp", "exit_status": exit_code})
        if exit_code:
            raise dl.DownloadError(dl._friendly_process_error(stderr))
    finally:
        dl._stop(proc)
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()

    media_files = [
        p for p in stage.iterdir()
        if p.is_file() and p.name.startswith("source.")
        and not p.name.endswith((".part", ".ytdl", ".info.json"))
    ]
    info_files = [p for p in stage.iterdir() if p.is_file() and p.name.startswith("source.") and p.name.endswith(".info.json")]
    if not media_files:
        raise dl.DownloadError("YouTube did not produce the requested video.")
    if not info_files:
        raise dl.DownloadError("YouTube did not return media metadata.")

    source = None
    source_probe = None
    for candidate in sorted(media_files, key=lambda p: p.stat().st_size, reverse=True):
        if candidate.stat().st_size > settings.max_source_file_size_bytes * 2:
            continue
        probe = dl._ffprobe(candidate, job_id=job_id, timeout=dl._remaining(deadline, 120))
        streams = probe.get("streams", [])
        if any(x.get("codec_type") == "video" for x in streams) and any(x.get("codec_type") == "audio" for x in streams):
            source = candidate
            source_probe = probe
            break
    if source is None or source_probe is None:
        raise dl.DownloadError("The downloaded source did not contain both video and audio.")

    try:
        info = json.loads(max(info_files, key=lambda p: p.stat().st_mtime).read_text(encoding="utf-8"))
    except Exception as exc:
        raise dl.DownloadError("YouTube metadata response was invalid.") from exc
    if info.get("is_live"):
        raise dl.DownloadError("Live streams are not supported. Wait until the stream has ended.")
    duration = float(info.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise dl.DownloadError("The video duration could not be verified.")
    if duration > settings.max_duration_seconds:
        raise dl.DownloadError(f"Video is longer than the {settings.max_duration_seconds // 60}-minute limit.")
    title = str(info.get("title") or info.get("id") or "YouTube Media")
    return source, {
        "url": normalize_youtube_url(url), "video_id": str(info.get("id") or ""),
        "title": title, "safe_title": safe_filename(title), "duration": duration,
        "thumbnail": safe_thumbnail(info.get("thumbnail")),
    }, source_probe


def _source_streams(probe: dict) -> tuple[dict, dict]:
    streams = probe.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    return video, audio


def _video_ffmpeg_command(source: Path, final: Path, quality: str, source_probe: dict) -> tuple[list[str], str]:
    video, audio = _source_streams(source_probe)
    video_codec = str(video.get("codec_name") or "").lower()
    audio_codec = str(audio.get("codec_name") or "").lower()
    pix_fmt = str(video.get("pix_fmt") or "").lower()

    can_copy_video = video_codec == "h264" and pix_fmt in {"yuv420p", "yuvj420p"}
    cmd = [
        settings.ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-i", str(source), "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1",
    ]
    if can_copy_video:
        cmd += ["-c:v", "copy"]
        if audio_codec == "aac":
            cmd += ["-c:a", "copy"]
            mode = "remux"
        else:
            cmd += ["-c:a", "aac", "-b:a", "192k"]
            mode = "video-copy-audio-transcode"
    else:
        vf = {"low": "scale=-2:min(480\\,ih)", "medium": "scale=-2:min(720\\,ih)", "maximum": None}[quality]
        if vf:
            cmd += ["-vf", vf]
        cmd += [
            "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
        ]
        mode = "encode"
    cmd += ["-movflags", "+faststart", "-shortest", "-progress", "pipe:1", "-stats_period", "0.5", "-nostats", str(final)]
    return cmd, mode


def _run_ffmpeg_with_progress(cmd: list[str], duration: float, job_id: str, progress, deadline: float) -> None:
    proc = dl._popen([str(x) for x in cmd])
    out_q: queue.Queue[str] = queue.Queue()
    stderr_parts: list[str] = []
    stdout_done = threading.Event()
    stderr_done = threading.Event()

    def read_stdout() -> None:
        try:
            if proc.stdout:
                for line in proc.stdout:
                    out_q.put(line)
        finally:
            stdout_done.set()

    def read_stderr() -> None:
        try:
            if proc.stderr:
                tail = ""
                while True:
                    chunk = proc.stderr.read(4096)
                    if not chunk:
                        break
                    tail = (tail + chunk)[-32768:]
                stderr_parts.append(tail)
        finally:
            stderr_done.set()

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()
    last_pct = -1.0
    try:
        while True:
            if redis_conn().get(f"audioera:cancel:{job_id}"):
                dl._stop(proc)
                raise Cancelled("The operation was cancelled.")
            if time.monotonic() >= deadline:
                dl._stop(proc)
                raise dl.DownloadError("Job processing timeout exceeded.")
            try:
                line = out_q.get(timeout=0.2).strip()
            except queue.Empty:
                line = ""
            if line.startswith("out_time_us="):
                try:
                    out_us = max(0, int(line.split("=", 1)[1]))
                    pct = min(99.5, (out_us / max(duration * 1_000_000.0, 1.0)) * 100.0)
                    if pct >= last_pct + 0.8:
                        last_pct = pct
                        progress("processing", "Finishing", f"{pct:.1f}")
                except (TypeError, ValueError):
                    pass
            elif line == "progress=end":
                progress("processing", "Finishing", "100")
            if proc.poll() is not None and stdout_done.is_set() and out_q.empty():
                break
        stderr_done.wait(2)
        stderr = "".join(stderr_parts)
        exit_code = int(proc.returncode or 0)
        dl.log.info("process_exit", extra={"job_id": job_id, "process_name": "ffmpeg", "exit_status": exit_code})
        if exit_code:
            raise dl.DownloadError(dl._friendly_process_error(stderr))
    finally:
        dl._stop(proc)
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()


def video_one_pass(url: str, quality: str, job_id: str, progress) -> tuple[Path, str, dict, dict]:
    dl.ensure_disk_capacity("video")
    deadline = time.monotonic() + settings.job_timeout_seconds
    work_parent = settings.job_root / "work"
    work_parent.mkdir(parents=True, exist_ok=True)
    job_dir = work_parent / job_id
    job_dir.mkdir(parents=False, exist_ok=False)
    (job_dir / ".expires").write_text(str(int(time.time()) + settings.job_timeout_seconds + 300), encoding="ascii")
    source, metadata, source_probe = _video_source_and_metadata(url, quality, job_id, job_dir, progress, deadline)
    final = job_dir / "final.mp4"
    cmd, mode = _video_ffmpeg_command(source, final, quality, source_probe)
    dl.log.info("video_finalize_mode", extra={"job_id": job_id, "mode": mode})
    progress("processing", "Finishing", "1")
    with dl.FfmpegSlot(job_id, deadline):
        _run_ffmpeg_with_progress(cmd, float(metadata["duration"]), job_id, progress, deadline)
    progress("validating", "Finishing", "99")
    details = dl.validate_video(final, float(metadata["duration"]), job_id=job_id, timeout=dl._remaining(deadline, 120))
    details["finalize_mode"] = mode
    if final.stat().st_size > settings.max_file_size_bytes:
        raise dl.DownloadError("The finished file exceeds the configured size limit.")
    return final, safe_filename(metadata["title"]) + ".mp4", details, metadata
