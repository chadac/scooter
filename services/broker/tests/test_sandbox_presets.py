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
