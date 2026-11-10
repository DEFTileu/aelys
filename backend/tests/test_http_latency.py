from __future__ import annotations

from app.main import app
from fastapi.testclient import TestClient


def test_every_response_reports_server_time():
    with TestClient(app) as client:
        timing = client.get("/healthz").headers["Server-Timing"]
    assert timing.startswith("app;dur=") and float(timing.split("=")[1]) >= 0
