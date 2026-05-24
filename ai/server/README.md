# AI inference service

FastAPI server that exposes the inference pipelines in [`ai/`](..) over HTTP so
the browser viewer can call them.

## Quickstart

```bash
# From the repo root.
cd ai/server
python -m venv .venv && source .venv/bin/activate

# 1. Install PyTorch matching your hardware (CPU or CUDA build):
#    https://pytorch.org/get-started/locally/
# 2. Then everything else:
pip install -r requirements.txt

# Start the server from the repo root so `ai.main` is importable.
cd ../..
uvicorn ai.server.app:app --host 0.0.0.0 --port 8000
```

Sanity checks:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/models
curl -F file=@/path/to/scan.nii.gz \
     http://localhost:8000/predict/vertebrae \
     -o /tmp/seg.nii.gz
```

## Configuration

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `AI_SERVICE_CORS_ORIGINS` | `http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080` | Comma-separated CORS allow-list for the viewer origin. |

The viewer side reads the service URL from `window.config.aiServiceUrl`
(see [`platform/app/public/config/default.js`](../../platform/app/public/config/default.js)).

## Endpoints

- `GET  /health` — liveness probe.
- `GET  /models` — JSON catalog: `{ models: [{id, name, description, modality, labelNames}] }`.
- `POST /predict/{model_id}` — `multipart/form-data` with `file=<NIfTI>`; returns the segmentation as `application/gzip`. The response includes `X-Label-Names` so the client can name segments without a second round-trip.

## Adding a new model

Add an entry to [`models_registry.py`](models_registry.py):

```python
MODELS["my_model"] = ModelInfo(
    id="my_model",
    name="My new model",
    description="Short description shown in the AI Models panel.",
    modality="CT",
    label_names={1: "structure_a", 2: "structure_b"},
    run=my_run_function,  # (input_path, output_path) -> output_path
)
```

The viewer's `/models` request will pick it up automatically.
