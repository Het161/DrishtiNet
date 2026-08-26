"""
DrishtiNet analytics service.

Importing this package pins every machine-learning cache inside the repository, before any library
that reads those variables is imported.

This is not tidiness. The workspace rule is that nothing is created outside the repository, and
these libraries default to writing under ``$HOME`` — Ultralytics to its own settings directory,
Torch to a hub cache, HuggingFace to yet another. Setting the variables in a Makefile target works
only for calls that go through that target; a plain ``python -c`` bypasses it, and Ultralytics then
silently writes to ``~/Library/Application Support``. Doing it here means the guarantee holds
however the code is entered, including from a test runner or a REPL.
"""

from __future__ import annotations

import os
from pathlib import Path

#: services/analytics/src/analytics/__init__.py -> repository root
REPO_ROOT = Path(__file__).resolve().parents[4]

_CACHE_VARS = {
    "YOLO_CONFIG_DIR": REPO_ROOT / ".cache" / "ultralytics",
    "TORCH_HOME": REPO_ROOT / ".cache" / "torch",
    "HF_HOME": REPO_ROOT / ".cache" / "huggingface",
    "EASYOCR_MODULE_PATH": REPO_ROOT / ".cache" / "easyocr",
    "MPLCONFIGDIR": REPO_ROOT / ".cache" / "matplotlib",
}

for _var, _path in _CACHE_VARS.items():
    # An explicit setting wins — a container may legitimately point these elsewhere. Only the
    # unset case, which is the one that leaks into $HOME, is filled in.
    if not os.environ.get(_var):
        _path.mkdir(parents=True, exist_ok=True)
        os.environ[_var] = str(_path)

__all__ = ["REPO_ROOT"]
