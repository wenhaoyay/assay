"""Assay API. Wiring only: middleware, routers, error mapping, the built web app."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from assay import __version__
from assay.datasets import DatasetError
from assay.env import load_dotenv
from assay.store import db
from assay.store import service as svc
from assay.store.service import Conflict, NotFound, PolicyError

from .routers import core, datasets, runs, workspace

load_dotenv()
log = logging.getLogger("assay")
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.upgrade()
    with db.session() as s:
        svc.recover_after_restart(s)  # what a restart interrupted is said to be failed or stopped, not left running
    yield


app = FastAPI(title="Assay API", version=__version__, lifespan=lifespan,
              description="Evaluation and regression testing for RAG chatbots and tool-using agents.")
# Answer only requests addressed to this machine by name: a web page that rebinds its own domain
# to 127.0.0.1 (DNS rebinding) cannot reach the API. ASSAY_ALLOWED_HOSTS adds names, comma-separated.
_hosts = ["localhost", "127.0.0.1", "testserver"]
_hosts += [h.strip() for h in os.environ.get("ASSAY_ALLOWED_HOSTS", "").split(",") if h.strip()]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5240", "http://127.0.0.1:5240"],
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(Conflict)
async def _conflict(_: Request, exc: Conflict) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.exception_handler(PolicyError)
async def _policy(_: Request, exc: PolicyError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=422)


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
app.include_router(workspace.router)


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
