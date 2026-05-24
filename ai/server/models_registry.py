"""Registry of AI models exposed by the inference server.

Each entry describes a model (id, name, description, modality) and a `run`
callable that performs inference: `run(input_path, output_path) -> output_path`.

To add a new model, write an adapter that wraps the underlying inference
function and add an entry below.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Callable, Dict, List

# Make the `ai` package importable when this file is run directly.
_AI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = os.path.dirname(_AI_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


@dataclass
class ModelInfo:
    id: str
    name: str
    description: str
    modality: str
    label_names: Dict[int, str]
    run: Callable[[str, str], str]


def _run_vertebrae(input_path: str, output_path: str) -> str:
    # Imported lazily so the server can start without pulling torch when only
    # the catalog endpoint is being hit (e.g. health checks in CI).
    from ai.main import run_inference

    return run_inference(input_path, output_path)


# Label names mirror ai/main.py LABEL_NAMES; kept here so the frontend can
# receive them via GET /models without parsing main.py.
_VERTEBRAE_LABELS: Dict[int, str] = {
    1: "L5", 2: "L4", 3: "L3", 4: "L2", 5: "L1",
    6: "T12", 7: "T11", 8: "T10", 9: "T9", 10: "T8", 11: "T7",
    12: "T6", 13: "T5", 14: "T4", 15: "T3", 16: "T2", 17: "T1",
    18: "C7", 19: "C6", 20: "C5", 21: "C4", 22: "C3", 23: "C2", 24: "C1",
}


MODELS: Dict[str, ModelInfo] = {
    "vertebrae": ModelInfo(
        id="vertebrae",
        name="Vertebrae detection",
        description=(
            "nnU-Net (TotalSegmentator Task252) — 24 vertebra labels from L5 to C1. "
            "Expects a CT NIfTI volume; outputs a label NIfTI in the same space."
        ),
        modality="CT",
        label_names=_VERTEBRAE_LABELS,
        run=_run_vertebrae,
    ),
}


def list_models() -> List[Dict]:
    return [
        {
            "id": m.id,
            "name": m.name,
            "description": m.description,
            "modality": m.modality,
            "labelNames": {str(k): v for k, v in m.label_names.items()},
        }
        for m in MODELS.values()
    ]


def get_model(model_id: str) -> ModelInfo:
    if model_id not in MODELS:
        raise KeyError(model_id)
    return MODELS[model_id]
