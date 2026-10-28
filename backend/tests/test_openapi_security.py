from app.main import app
from starlette.testclient import TestClient


def test_openapi_declares_bearer_security_for_protected_routes():
    schema = app.openapi()
    assert schema["components"]["securitySchemes"]["HTTPBearer"] == {"type": "http", "scheme": "bearer"}
    assert {"HTTPBearer": []} in schema["paths"]["/api/v1/me"]["get"]["security"]

def test_http_responses_include_baseline_security_headers():
    response = TestClient(app).get("/healthz")
    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Permissions-Policy"] == "camera=(), microphone=(), geolocation=()"
