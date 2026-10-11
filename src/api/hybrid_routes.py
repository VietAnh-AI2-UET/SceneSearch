"""Local Hybrid V2 indexes use their own embedding and ranking contract."""

import os
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from src.api.dependencies import get_actor, production_mode
from src.hybrid.config import load_hybrid_config
from src.hybrid.service import HybridService

router = APIRouter(prefix="/hybrid", tags=["hybrid-v2"])


@lru_cache
def configured_service(path):
    return HybridService(load_hybrid_config(path))


def get_hybrid_service():
    if production_mode():
        raise HTTPException(403, "HYBRID_LOCAL_ONLY")
    path = os.getenv("HYBRID_CONFIG")
    if not path:
        raise HTTPException(503, "HYBRID_CONFIG_REQUIRED")
    return configured_service(path)


class HybridSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    top_k: int = Field(default=10, ge=1, le=100)
    ranker: Literal["caption", "stage3", "base", "stage5", "dense", "dense-entity"] | None = None


class HybridIndexRequest(BaseModel):
    video: str = Field(min_length=1)
    max_windows: int | None = Field(default=None, ge=1)


@router.get("/indexes")
def indexes(actor=Depends(get_actor), service=Depends(get_hybrid_service)):
    return {"indexes": service.list_indexes(actor)}


@router.post("/indexes/{index_id}/search")
def search(index_id: str, body: HybridSearchRequest, actor=Depends(get_actor), service=Depends(get_hybrid_service)):
    try:
        return service.search(index_id, body.query, actor, top_k=body.top_k, ranker=body.ranker)
    except (ValueError, RuntimeError, OSError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/jobs", status_code=202)
def start_job(
    body: HybridIndexRequest, tasks: BackgroundTasks, actor=Depends(get_actor), service=Depends(get_hybrid_service)
):
    job, command = service.prepare_job(body.video, actor, max_windows=body.max_windows)
    tasks.add_task(service.run_job, job, command)
    return job


@router.get("/jobs/{job_id}")
def job(job_id: str, actor=Depends(get_actor), service=Depends(get_hybrid_service)):
    return service.get_job(job_id, actor)
