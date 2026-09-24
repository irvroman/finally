"""Point every db test at a fresh temporary SQLite file."""

import pytest


@pytest.fixture(autouse=True)
def db_path(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(path))
    return path
