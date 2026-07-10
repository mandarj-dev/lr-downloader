"""
LR Document Downloader
-----------------------
Fetches LR (docket) documents from an S3 bucket and returns them as a ZIP
download in the browser, organized into a folder named by Invoice No.

For each LR number, it tries:
<BASE_S3_URL><LR_NO><POD_SUFFIX>.pdf, .jpg, .jpeg, .png
(in that order) and includes the first one that exists.

Run locally:
    uvicorn app:app --host 127.0.0.1 --port 8000 --reload

Then open http://127.0.0.1:8000 in your browser.
"""

import asyncio
import io
import json
import logging
import os
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration (driven via .env / Vercel environment variables)
# ---------------------------------------------------------------------------
BASE_S3_URL = os.getenv(
    "BASE_S3_URL",
    "https://courier-weight-images.s3.ap-south-1.amazonaws.com/tracking_pod_image/",
)
if not BASE_S3_URL.endswith("/"):
    BASE_S3_URL += "/"

POD_SUFFIX = os.getenv("POD_SUFFIX", "_pod")

EXTENSIONS = [
    ext.strip().lstrip(".")
    for ext in os.getenv("EXTENSIONS", "pdf,jpg,jpeg,png").split(",")
    if ext.strip()
]
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20"))
MAX_CONCURRENT_DOWNLOADS = int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "5"))

# ---------------------------------------------------------------------------
# Logging (stdout only — Vercel has no persistent local filesystem)
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("lr_downloader")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="LR Document Downloader")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Only allow safe folder/file name characters (letters, digits, - _ .)
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_\-. ]+")


def sanitize_name(value: str) -> str:
    """Strip anything that isn't a safe filesystem character, block path traversal."""
    value = value.strip()
    value = SAFE_NAME_RE.sub("_", value)
    value = value.replace("..", "_")
    return value or "unnamed"


def parse_lr_numbers(raw: str) -> List[str]:
    """Split textarea input into a clean, de-duplicated list of LR numbers."""
    lines = [line.strip() for line in raw.replace(",", "\n").splitlines()]
    seen = set()
    result = []
    for line in lines:
        if not line:
            continue
        cleaned = sanitize_name(line)
        if cleaned not in seen:
            seen.add(cleaned)
            result.append(cleaned)
    return result


async def fetch_one(
    client: httpx.AsyncClient, lr_no: str
) -> Tuple[dict, Optional[Tuple[str, bytes]]]:
    """Try each extension in order for a single LR number; return first match in memory."""
    for ext in EXTENSIONS:
        url = f"{BASE_S3_URL}{lr_no}{POD_SUFFIX}.{ext}"
        try:
            resp = await client.get(url, timeout=REQUEST_TIMEOUT)
        except httpx.RequestError as exc:
            logger.warning("Request error for %s: %s", url, exc)
            continue

        if resp.status_code == 200 and resp.content:
            file_name = f"{lr_no}.{ext}"
            logger.info("Fetched %s (%d bytes)", url, len(resp.content))
            result = {
                "lr_no": lr_no,
                "status": "success",
                "file_name": file_name,
                "size_bytes": len(resp.content),
                "source_url": url,
            }
            return result, (file_name, resp.content)

    logger.warning("Not found for LR %s (tried extensions: %s)", lr_no, EXTENSIONS)
    return {
        "lr_no": lr_no,
        "status": "not_found",
        "tried_extensions": EXTENSIONS,
    }, None


def build_zip(
    invoice_folder_name: str,
    files: List[Tuple[str, bytes]],
    payload: dict,
) -> bytes:
    """Build an in-memory ZIP with fetched files plus a results manifest."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_name, content in files:
            zf.writestr(f"{invoice_folder_name}/{file_name}", content)
        zf.writestr(
            f"{invoice_folder_name}/_results.json",
            json.dumps(payload, indent=2),
        )
    return buffer.getvalue()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "base_s3_url": BASE_S3_URL,
            "pod_suffix": POD_SUFFIX,
            "extensions": ", ".join(EXTENSIONS),
        },
    )


@app.post("/api/download")
async def download_files(invoice_no: str = Form(...), lr_numbers: str = Form(...)):
    invoice_folder_name = sanitize_name(invoice_no)
    lr_list = parse_lr_numbers(lr_numbers)

    if not lr_list:
        return JSONResponse(
            status_code=400, content={"error": "No valid LR numbers provided."}
        )

    logger.info(
        "Starting download job | invoice=%s | lr_count=%d",
        invoice_folder_name,
        len(lr_list),
    )

    async with httpx.AsyncClient() as client:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)

        async def bound_fetch(lr_no: str):
            async with semaphore:
                return await fetch_one(client, lr_no)

        fetched = await asyncio.gather(*(bound_fetch(lr) for lr in lr_list))

    results = []
    files: List[Tuple[str, bytes]] = []
    for result, file_data in fetched:
        results.append(result)
        if file_data is not None:
            files.append(file_data)

    success_count = sum(1 for r in results if r["status"] == "success")
    not_found_count = len(results) - success_count
    timestamp = datetime.now().isoformat(timespec="seconds")

    payload = {
        "invoice_no": invoice_folder_name,
        "total": len(lr_list),
        "success_count": success_count,
        "not_found_count": not_found_count,
        "results": results,
        "timestamp": timestamp,
    }

    if success_count == 0:
        return JSONResponse(
            status_code=404,
            content={
                **payload,
                "error": "No documents found for the given LR numbers.",
            },
        )

    zip_bytes = build_zip(invoice_folder_name, files, payload)
    zip_name = f"{invoice_folder_name}.zip"

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_name}"',
            "X-Invoice-No": invoice_folder_name,
            "X-Total": str(len(lr_list)),
            "X-Success-Count": str(success_count),
            "X-Not-Found-Count": str(not_found_count),
            "X-Results": json.dumps(results),
        },
    )


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "base_s3_url": BASE_S3_URL,
        "pod_suffix": POD_SUFFIX,
        "extensions": EXTENSIONS,
    }
