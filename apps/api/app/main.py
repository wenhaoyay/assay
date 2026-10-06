"""GaugeLab API. Wiring only: middleware, routers, error mapping, the built web app."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select

from gaugelab import __version__
from gaugelab.datasets import DatasetError
from gaugelab.env import load_dotenv
from gaugelab.store import db
from gaugelab.store import models as m
from gaugelab.store.service import Conflict, NotFound

from .routers import core, datasets, runs

load_dotenv()
log = logging.getLogger("gaugelab")
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.upgrade()
    with db.session() as s:
        # A run cannot survive a server restart: say so instead of showing it as running forever.
        for run in s.scalars(select(m.Run).where(m.Run.status.in_(["queued", "running"]))):
            run.status, run.error = "failed", "Interrupted: the server stopped while this run was in progress."
    yield


app = FastAPI(title="GaugeLab API", version=__version__, lifespan=lifespan,
              description="Evaluation and regression testing for RAG chatbots and tool-using agents.")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5240", "http://127.0.0.1:5240"],
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(Conflict)
async def _conflict(_: Request, exc: Conflict) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.exception_handler(DatasetError)
async def _dataset(_: Request, exc: DatasetError) -> JSONResponse:
    return JSONResponse({"detail": {"message": "Validation errors.", "errors": exc.errors[:100]}}, status_code=422)


@app.get("/api/health")
def health() -> dict[str, str]:
    url = db.database_url()
    return {"status": "ok", "version": __version__, "database": url.split(":", 1)[0]}


app.include_router(core.router)
app.include_router(datasets.router)
app.include_router(runs.router)


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    """Serve the built web app (apps/web/dist) when present; the API lives under /api."""
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    if not WEB_DIST.is_dir():
        return JSONResponse({"detail": "Web app not built. Run `make web` (or use the Vite dev server on :5240)."},
                            status_code=404)
    target = (WEB_DIST / path).resolve()
    if path and target.is_file() and WEB_DIST.resolve() in target.parents:
        return FileResponse(target)
    return FileResponse(WEB_DIST / "index.html")
