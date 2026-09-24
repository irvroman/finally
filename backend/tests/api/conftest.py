import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.services.fakes import FakeSource


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "no-static"))
    monkeypatch.setenv("LLM_MOCK", "true")
    sources: list[FakeSource] = []

    def factory(cache):
        src = FakeSource(cache, prices={"AAPL": 190.0, "MSFT": 400.0, "PYPL": 60.0},
                         unpriced={"NOPRICE"})
        sources.append(src)
        return src

    app = create_app(source_factory=factory)
    with TestClient(app) as c:
        c.source = sources[0]
        yield c
