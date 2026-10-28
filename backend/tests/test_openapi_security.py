from app.main import app


def test_openapi_declares_bearer_security_for_protected_routes():
    schema = app.openapi()
    assert schema["components"]["securitySchemes"]["HTTPBearer"] == {"type": "http", "scheme": "bearer"}
    assert {"HTTPBearer": []} in schema["paths"]["/api/v1/me"]["get"]["security"]
