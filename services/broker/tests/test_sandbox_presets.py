"""Unit tests for named sandbox size presets — config parsing and preset resolution."""

from __future__ import annotations

import json
import os

import pytest

from broker.sandbox.config import sandbox_sizes, preset_to_resources
from broker.sandbox.resources import SandboxResources, InvalidResource
from broker.config import BrokerSettings


def test_sandbox_sizes_parses_json():
    """sandbox_sizes() parses SANDBOX_SIZES_JSON into a dict of presets."""
    settings = BrokerSettings(
        sandbox_sizes_json='{"tiny": {"cpu": "250m", "memory": "256Mi"}, "large": {"cpu": "4", "memory": "16Gi"}}'
    )
    sizes = sandbox_sizes(settings)
    assert "tiny" in sizes
    assert sizes["tiny"] == {"cpu": "250m", "memory": "256Mi"}
    assert sizes["large"] == {"cpu": "4", "memory": "16Gi"}


def test_sandbox_sizes_returns_empty_when_unset():
    """sandbox_sizes() returns {} when SANDBOX_SIZES_JSON is empty."""
    settings = BrokerSettings(sandbox_sizes_json="")
    assert sandbox_sizes(settings) == {}


def test_preset_to_resources_sets_requests_and_limits():
    """preset_to_resources() renders a preset as SandboxResources with requests == limits."""
    preset = {"cpu": "2", "memory": "4Gi"}
    spec = preset_to_resources(preset)
    assert spec.requests == {"cpu": "2", "memory": "4Gi"}
    assert spec.limits == {"cpu": "2", "memory": "4Gi"}


def test_preset_to_resources_validates_quantities():
    """preset_to_resources() validates cpu/memory quantities and rejects bad ones."""
    with pytest.raises(InvalidResource) as exc:
        preset_to_resources({"cpu": "2cores", "memory": "4Gi"})
    assert "cpu" in str(exc.value)

    with pytest.raises(InvalidResource) as exc:
        preset_to_resources({"cpu": "2", "memory": "4gb"})
    assert "memory" in str(exc.value)


def test_preset_to_resources_with_valid_quantities():
    """preset_to_resources() accepts valid k8s quantity formats."""
    # Millicpu + binary memory suffix
    spec = preset_to_resources({"cpu": "500m", "memory": "512Mi"})
    assert spec.requests == {"cpu": "500m", "memory": "512Mi"}
    
    # Whole CPU + decimal memory suffix
    spec = preset_to_resources({"cpu": "4", "memory": "2G"})
    assert spec.requests == {"cpu": "4", "memory": "2G"}


def test_preset_to_resources_carries_gpu_on_both_sides():
    """A gpu preset renders the count on requests AND limits — k8s rejects a GPU
    request that differs from its limit, so one count must land on both."""
    spec = preset_to_resources({"cpu": "4", "memory": "16Gi", "gpu": 1})
    assert spec.requests == {"cpu": "4", "memory": "16Gi", "gpu": 1}
    assert spec.limits == {"cpu": "4", "memory": "16Gi", "gpu": 1}


def test_preset_to_resources_omits_gpu_when_absent_or_none():
    """A CPU-only preset carries NO gpu key — an explicit 0/None would otherwise
    render as an nvidia.com/gpu request on a cluster with no GPUs."""
    assert "gpu" not in preset_to_resources({"cpu": "2", "memory": "4Gi"}).requests
    assert "gpu" not in preset_to_resources({"cpu": "2", "memory": "4Gi", "gpu": None}).requests


def test_preset_to_resources_requests_and_limits_are_distinct_objects():
    """The two sides must not alias: mutating one must not silently change the other."""
    spec = preset_to_resources({"cpu": "2", "memory": "4Gi", "gpu": 1})
    spec.requests["cpu"] = "99"
    assert spec.limits["cpu"] == "2"


def test_sandbox_sizes_parses_gpu_presets():
    """sandbox_sizes() round-trips a gpu preset from SANDBOX_SIZES_JSON."""
    settings = BrokerSettings(
        sandbox_sizes_json='{"gpu-small": {"cpu": "4", "memory": "16Gi", "gpu": 1}}'
    )
    assert sandbox_sizes(settings)["gpu-small"] == {"cpu": "4", "memory": "16Gi", "gpu": 1}
