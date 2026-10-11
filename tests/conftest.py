"""Shared helpers: load the hyphen-named product scripts as modules."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load_script(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def check():
    return load_script("dns_upstream_check", "dns-upstream-check.py")


@pytest.fixture
def probe():
    return load_script("dns_upstream_probe", "dns-upstream-probe.py")
