import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "configure_pages", Path(__file__).resolve().parents[1] / "ops" / "configure_pages.py"
)
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)


def test_create_once_and_use_cloudflare_assigned_hostname():
    existing = {"production_branch": "main", "subdomain": "dealfactory-123.pages.dev"}
    calls = []

    def api(url, token, data=None):
        calls.append((url, data))
        return existing if data or len(calls) > 2 else None

    for _ in range(2):
        assert pages.resolve_project("a" * 32, "test", "dealfactory", api) == (
            "https://dealfactory-123.pages.dev"
        )
    assert [data for _, data in calls] == [
        None, {"name": "dealfactory", "production_branch": "main"}, None
    ]
