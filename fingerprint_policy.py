from __future__ import annotations

import copy
import re


_MODEL_ID_SEPARATORS = re.compile(r"[^a-z0-9]+")
_DISABLED_MODEL_ID = "gpt61sol"


def is_disabled_model(model_id: object) -> bool:
    """Return whether a model ID names the disabled GPT 6.1 SOL candidate."""
    if not isinstance(model_id, str):
        return False
    normalized = _MODEL_ID_SEPARATORS.sub("", model_id.casefold())
    return normalized == _DISABLED_MODEL_ID


def filter_disabled_bank(bank: dict) -> dict:
    """Return a filtered bank with disabled model rows and aligned centers removed."""
    filtered = copy.deepcopy(bank)
    models = filtered.get("models")
    model_ids = (
        [model.get("id") for model in models if isinstance(model, dict)]
        if isinstance(models, list)
        else []
    )

    robust = filtered.get("robust")
    robust_order = robust.get("model_order") if isinstance(robust, dict) else None
    axis_ids = (
        robust_order
        if isinstance(robust_order, list) and robust_order
        else model_ids
    )
    disabled_indices = {
        index for index, model_id in enumerate(axis_ids)
        if is_disabled_model(model_id)
    }

    if isinstance(models, list):
        filtered["models"] = [
            model for model in models
            if not (isinstance(model, dict) and is_disabled_model(model.get("id")))
        ]

    if not isinstance(robust, dict) or not disabled_indices:
        return filtered

    if isinstance(robust_order, list):
        robust["model_order"] = [
            model_id for model_id in robust_order
            if not is_disabled_model(model_id)
        ]

    def drop_model_axis(rows: object, path: str) -> object:
        if not isinstance(rows, list):
            return rows
        if len(rows) != len(axis_ids):
            raise ValueError(f"{path} does not align with robust.model_order")
        return [row for index, row in enumerate(rows) if index not in disabled_indices]

    hellinger = robust.get("hellinger")
    if isinstance(hellinger, dict) and "centroids" in hellinger:
        hellinger["centroids"] = drop_model_axis(
            hellinger["centroids"], "robust.hellinger.centroids"
        )

    ordered_blocks = robust.get("ordered_blocks")
    if isinstance(ordered_blocks, dict):
        if "centroids" in ordered_blocks:
            ordered_blocks["centroids"] = drop_model_axis(
                ordered_blocks["centroids"], "robust.ordered_blocks.centroids"
            )
        if "environment_centroids" in ordered_blocks:
            environments = ordered_blocks["environment_centroids"]
            if isinstance(environments, list):
                ordered_blocks["environment_centroids"] = [
                    drop_model_axis(centroids, "robust.ordered_blocks.environment_centroids")
                    for centroids in environments
                ]

    return filtered
