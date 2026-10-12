"""Check the deploy package without downloading model weights."""

import asyncio
from pathlib import Path

from httpx import ASGITransport, AsyncClient

from src.indexing.config import load_pipeline_config
from src.main import app
from src.retrieval.config import load_retrieval_config

ROOT = Path(__file__).resolve().parents[1]


def test_health_endpoint():
    """Verify the health API response without entering model startup."""
    async def check():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/health")
            assert response.status_code == 200
            assert response.json()["status"] == "ok"

    asyncio.run(check())


def test_demo_ui_is_served():
    """Verify the root redirect and the packaged demo page."""
    async def check():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/", follow_redirects=True)
            assert response.status_code == 200
            assert response.url.path == "/ui/scenesearch_prototype.html"
            assert "text/html" in response.headers["content-type"]

    asyncio.run(check())


def test_demo_configs_share_model_and_storage():
    """Require indexing and search to use the same model and index directory."""
    indexing = load_pipeline_config(ROOT / "configs/indexing/local.yaml")
    retrieval = load_retrieval_config(ROOT / "configs/retrieval/local.yaml")
    assert indexing.driveretriever == retrieval.driveretriever
    assert indexing.storage.root_dir == retrieval.root_dir
