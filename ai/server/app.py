"""FastAPI service exposing AI inference models to the browser.

Run with:
    uvicorn ai.server.app:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health                  → {"status": "ok"}
    GET  /models                  → catalog of available models
    POST /predict/{model_id}      → multipart upload (file=NIfTI), returns .nii.gz
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import traceback
from typing import List

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .models_registry import get_model, list_models


def _cors_origins() -> List[str]:
    raw = os.environ.get(
        "AI_SERVICE_CORS_ORIGINS",
        "http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080",
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


app = FastAPI(title="Medical Viewer AI Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/models")
async def models() -> dict:
    return {"models": list_models()}


@app.post("/predict/{model_id}")
async def predict(model_id: str, file: UploadFile = File(...)):
    try:
        model = get_model(model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    if not file.filename or not (
        file.filename.endswith(".nii") or file.filename.endswith(".nii.gz")
    ):
        raise HTTPException(
            status_code=400,
            detail="file must be a NIfTI file with extension .nii or .nii.gz",
        )

    # We persist the temp directory for the duration of the response so that
    # FileResponse can stream the file before it is deleted.
    tmpdir = tempfile.mkdtemp(prefix=f"ai-{model_id}-")
    input_path = os.path.join(tmpdir, file.filename)
    output_path = os.path.join(
        tmpdir,
        file.filename.replace(".nii.gz", "").replace(".nii", "") + "_seg.nii.gz",
    )

    try:
        with open(input_path, "wb") as f:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)

        await asyncio.to_thread(model.run, input_path, output_path)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(exc), "type": type(exc).__name__},
        )

    download_name = os.path.basename(output_path)
    return FileResponse(
        output_path,
        media_type="application/gzip",
        filename=download_name,
        # Surface label names via a header so the client doesn't need a 2nd request.
        headers={
            "X-Model-Id": model.id,
            "X-Label-Names": ",".join(
                f"{idx}:{name}" for idx, name in sorted(model.label_names.items())
            ),
            "Access-Control-Expose-Headers": "X-Model-Id,X-Label-Names",
        },
    )
