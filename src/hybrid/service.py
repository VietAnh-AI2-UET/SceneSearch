"""Expose the existing offline Hybrid pipeline without mixing embedding spaces."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from src.hybrid.config import HybridConfig

ROOT = Path(__file__).resolve().parents[2]


def workspace_path(value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else ROOT / path).resolve()


class HybridService:
    def __init__(self, config: HybridConfig):
        self.config = config
        self.index_root = workspace_path(config.index_root)
        self.job_root = workspace_path(config.job_root)
        self.lock = threading.RLock()
        self.active_jobs = set()
        # Indexing/search share one slot: avoid loading multiple foundation models.
        self.compute = threading.Lock()

    def authorize(self, actor, *, engineer=False):
        if actor.tenant_id != self.config.tenant_id or self.config.access_scope_id not in actor.access_scope_ids:
            raise HTTPException(403, "SOURCE_FORBIDDEN")
        if engineer and not set(actor.roles) & {"Engineer", "Admin"}:
            raise HTTPException(403, "INDEX_ADMIN_REQUIRED")

    def source(self, value):
        path = workspace_path(value)
        roots = [workspace_path(root) for root in self.config.source_roots]
        if not any(path.is_relative_to(root) for root in roots):
            raise HTTPException(403, "SOURCE_FORBIDDEN")
        if not path.is_file():
            raise HTTPException(404, "SOURCE_UNAVAILABLE")
        return path

    @staticmethod
    def index_id(path):
        return hashlib.sha256(path.name.encode()).hexdigest()[:24]

    def _indexes(self):
        if not self.index_root.is_dir():
            return []
        return [
            p
            for p in sorted(self.index_root.iterdir())
            if p.is_dir() and p.resolve().is_relative_to(self.index_root) and (p / "index_meta.json").is_file()
        ]

    def resolve_index(self, index_id, actor):
        self.authorize(actor)
        for path in self._indexes():
            if self.index_id(path) == index_id:
                meta = json.loads((path / "index_meta.json").read_text(encoding="utf-8"))
                self.source(meta["video"]["path"])
                return path.resolve()
        raise HTTPException(404, "INDEX_NOT_FOUND")

    def list_indexes(self, actor):
        self.authorize(actor)
        from hybrid_v2.dense_metadata import DENSE_FORMAT
        from hybrid_v2.local_runtime import FORMAT

        result = []
        for path in self._indexes():
            try:
                meta = json.loads((path / "index_meta.json").read_text(encoding="utf-8"))
                if meta.get("format") not in (FORMAT, DENSE_FORMAT):
                    continue
                self.source(meta["video"]["path"])
                result.append(
                    {
                        "index_id": self.index_id(path),
                        "name": path.name,
                        "model_family": "hybrid_v2",
                        "windows": meta["num_windows"],
                        "ready": "validate" in meta.get("phases", {}),
                        "caption_fallback_rate": meta.get("caption_stats", {}).get("fallback_rate"),
                    }
                )
            except (OSError, ValueError, KeyError, HTTPException):
                continue
        return result

    def search(self, index_id, query, actor, *, top_k=10, ranker=None):
        path = self.resolve_index(index_id, actor)
        if not self.compute.acquire(blocking=False):
            raise HTTPException(429, "HYBRID_BUSY")
        try:
            from hybrid_v2.local_video_search import search

            results = search(path, query, top_k=top_k, ranker=ranker or self.config.ranker)
            return {
                "index_id": index_id,
                "model_family": "hybrid_v2",
                "ranker": results[0]["ranker"] if results else ranker or self.config.ranker,
                "results": results,
            }
        finally:
            self.compute.release()

    def _write_job(self, job):
        self.job_root.mkdir(parents=True, exist_ok=True)
        path = self.job_root / (job["job_id"] + ".json")
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(job, indent=2), encoding="utf-8")
        temporary.replace(path)

    def get_job(self, job_id, actor):
        self.authorize(actor, engineer=True)
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            raise HTTPException(404, "JOB_NOT_FOUND")
        with self.lock:
            path = self.job_root / (job_id + ".json")
            if not path.is_file():
                raise HTTPException(404, "JOB_NOT_FOUND")
            job = json.loads(path.read_text(encoding="utf-8"))
        if job["actor_id"] != actor.actor_id and "Admin" not in actor.roles:
            raise HTTPException(403, "SOURCE_FORBIDDEN")
        with self.lock:
            if job["status"] in {"queued", "running"} and job_id not in self.active_jobs:
                job = {**job, "status": "failed", "error": "API restarted before indexing finished; submit a new job."}
                self._write_job(job)
        metadata = self.index_root / ("api_" + job_id) / "index_meta.json"
        if metadata.is_file():
            meta = json.loads(metadata.read_text(encoding="utf-8"))
            job["completed_phases"] = list(meta.get("phases", {}))
        return job

    def prepare_job(self, video, actor, *, max_windows=None):
        self.authorize(actor, engineer=True)
        source = self.source(video)
        if not self.compute.acquire(blocking=False):
            raise HTTPException(429, "HYBRID_BUSY")
        try:
            job_id = uuid4().hex
            target = self.index_root / ("api_" + job_id)
            job = {
                "job_id": job_id,
                "actor_id": actor.actor_id,
                "status": "queued",
                "index_id": self.index_id(target),
                "model_family": "hybrid_v2",
            }
            with self.lock:
                self._write_job(job)
                self.active_jobs.add(job_id)
            return job, self.command(source, target, max_windows)
        except Exception:
            self.compute.release()
            raise

    def command(self, video, output, max_windows=None):
        command = [
            sys.executable,
            "-B",
            "-m",
            "hybrid_v2.laptop_cli",
            "index",
            "--video",
            str(video),
            "--output",
            str(output),
            "--local-files-only",
        ]
        for name in ("stage2b_checkpoint", "stage3a_checkpoint", "stage5_checkpoint", "hf_cache_dir", "detector"):
            command += ["--" + name.replace("_", "-"), str(workspace_path(getattr(self.config, name)))]
        for name in (
            "device",
            "precision",
            "siglip_revision",
            "bge_model",
            "bge_revision",
            "qwen_base_url",
            "vlm_model",
        ):
            value = getattr(self.config, name)
            if value is not None:
                command += ["--" + name.replace("_", "-"), str(value)]
        command += [
            "--visual-batch-size",
            "1",
            "--vision-chunk-size",
            "4",
            "--yolo-device",
            "cpu",
            "--bge-device",
            "cpu",
        ]
        if max_windows is not None:
            command += ["--max-windows", str(max_windows)]
        return command

    def run_job(self, job, command):
        try:
            with self.lock:
                job = {**job, "status": "running"}
                self._write_job(job)
            environment = os.environ.copy()
            environment["OMP_NUM_THREADS"] = str(self.config.cpu_threads)
            environment["MKL_NUM_THREADS"] = str(self.config.cpu_threads)
            with (self.job_root / (job["job_id"] + ".log")).open("w", encoding="utf-8") as log:
                completed = subprocess.run(
                    command,
                    cwd=ROOT,
                    env=environment,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            job["status"] = "ready" if completed.returncode == 0 else "failed"
            if completed.returncode:
                job["error"] = "Hybrid indexing failed; inspect the job log on the server."
        except Exception as exc:
            job["status"] = "failed"
            job["error"] = str(exc)
        finally:
            try:
                with self.lock:
                    self._write_job(job)
                    self.active_jobs.discard(job["job_id"])
            finally:
                self.compute.release()
