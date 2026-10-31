import os

import pytest

# Tests use a deterministic non-production key; application startup requires
# operators to provide AELYS_SECRET_KEY explicitly.
os.environ.setdefault("AELYS_SECRET_KEY", "test-only-aelys-secret-key-0123456789")
# The suite exercises the legacy password transports; production defaults leave password bootstrap off.
os.environ.setdefault("AELYS_PASSWORD_BOOTSTRAP_ENABLED", "true")


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    from app.core import ratelimit

    ratelimit.reset()
    yield
    ratelimit.reset()
