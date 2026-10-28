import os

# Tests use a deterministic non-production key; application startup requires
# operators to provide AELYS_SECRET_KEY explicitly.
os.environ.setdefault("AELYS_SECRET_KEY", "test-only-aelys-secret-key-0123456789")
