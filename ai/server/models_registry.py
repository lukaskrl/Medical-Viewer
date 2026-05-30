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


def _run_vertebrae_ct(input_path: str, output_path: str) -> str:
    # Imported lazily so the server can start without pulling torch/nnunetv2
    # when only the catalog endpoint is being hit (e.g. health checks in CI).
    from ai.run_v2 import infer_nifti

    return infer_nifti("ct", input_path, output_path)


def _run_vertebrae_mri(input_path: str, output_path: str) -> str:
    from ai.run_v2 import infer_nifti

    return infer_nifti("mri", input_path, output_path)


# Label names mirror each model's dataset.json (foreground labels), kept here so
# the frontend can receive them via GET /models without loading the models.
_VERTEBRAE_CT_LABELS: Dict[int, str] = {
    1: "Sacrum", 2: "S1", 3: "L5", 4: "L4", 5: "L3", 6: "L2", 7: "L1",
    8: "T12", 9: "T11", 10: "T10", 11: "T9", 12: "T8", 13: "T7", 14: "T6",
    15: "T5", 16: "T4", 17: "T3", 18: "T2", 19: "T1",
    20: "C7", 21: "C6", 22: "C5", 23: "C4", 24: "C3", 25: "C2", 26: "C1",
}

_VERTEBRAE_MRI_LABELS: Dict[int, str] = {
    1: "Sacrum", 2: "L5", 3: "L4", 4: "L3", 5: "L2", 6: "L1",
    7: "T12", 8: "T11", 9: "T10", 10: "T9", 11: "T8", 12: "T7", 13: "T6",
    14: "T5", 15: "T4", 16: "T3", 17: "T2", 18: "T1",
    19: "C7", 20: "C6", 21: "C5", 22: "C4", 23: "C3", 24: "C2", 25: "C1",
}


MODELS: Dict[str, ModelInfo] = {
    "vertebrae_ct": ModelInfo(
        id="vertebrae_ct",
        name="Vertebrae (CT)",
        description=(
            "nnU-Net v2 (TotalSegmentator) — 26 labels incl. sacrum + S1, L5 to C1. "
            "Expects a CT NIfTI volume; outputs a label NIfTI in the same space."
        ),
        modality="CT",
        label_names=_VERTEBRAE_CT_LABELS,
        run=_run_vertebrae_ct,
    ),
    "vertebrae_mri": ModelInfo(
        id="vertebrae_mri",
        name="Vertebrae (MRI)",
        description=(
            "nnU-Net v2 (TotalSegmentator MRI) — 25 labels incl. sacrum, L5 to C1. "
            "Expects an MR NIfTI volume; outputs a label NIfTI in the same space."
        ),
        modality="MR",
        label_names=_VERTEBRAE_MRI_LABELS,
        run=_run_vertebrae_mri,
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
