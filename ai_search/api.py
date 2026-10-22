import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import SearchRequest, SearchResponse
from .providers import DeepSeek, ProviderError, Tavily, request_id_context, retry_count_context
from .service import SearchService

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5, write=10, pool=5), follow_redirects=False) as client:
        app.state.search_service = SearchService(DeepSeek(client), Tavily(client))
        yield


app = FastAPI(title="AI Search Service", lifespan=lifespan)
logger = logging.getLogger(__name__)
WEB_DIR = Path(__file__).with_name("web")
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
async def search_page():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/ai-search", response_model=SearchResponse)
async def ai_search(payload: SearchRequest, request: Request):
    request_id = secrets.token_hex(6)
    token = request_id_context.set(request_id)
    retry_token = retry_count_context.set([0])
    try:
        result = await asyncio.wait_for(request.app.state.search_service.search(payload), timeout=210)
        return result
    except asyncio.TimeoutError as exc:
        retry_count = retry_count_context.get()[0]
        logger.warning("search_timeout request_id=%s budget_seconds=210 retry_count=%d", request_id, retry_count)
        raise HTTPException(status_code=504, detail="AI search exceeded its time budget",
                            headers={"X-Request-ID": request_id, "X-Retry-Count": str(retry_count)}) from exc
    except ProviderError as exc:
        retry_count = retry_count_context.get()[0]
        logger.warning("search_provider_error request_id=%s provider=%s operation=%s category=%s http_status=%s error_code=%s retry_count=%d",
                       request_id, exc.provider, exc.operation, exc.category, exc.http_status or "-", exc.error_code or "-", retry_count)
        raise HTTPException(status_code=502, detail="An upstream search service failed",
                            headers={"X-Request-ID": request_id, "X-Retry-Count": str(retry_count)}) from exc
    finally:
        retry_count_context.reset(retry_token)
        request_id_context.reset(token)
