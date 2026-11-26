import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "editor", Path(__file__).resolve().parents[1] / "ops" / "editor.py"
)
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)


def test_copy_requires_observed_prices():
    assert editor.eligible_angles(0, False) == ["fit"]
    assert editor.eligible_angles(1, False) == ["fit"]
    assert editor.eligible_angles(1, True) == ["fit", "price_drop"]
    assert editor.eligible_angles(2, False) == ["fit", "compare"]
