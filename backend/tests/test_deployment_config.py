import json
import os
import subprocess
from pathlib import Path

import pytest
from app.core.config import Settings

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("postgres://user:pass@db:5432/aelys", "postgresql+asyncpg://user:pass@db:5432/aelys"),
        ("postgresql://db/aelys?ssl=require", "postgresql+asyncpg://db/aelys?ssl=require"),
        ("postgresql+asyncpg://db/aelys", "postgresql+asyncpg://db/aelys"),
        ("sqlite+aiosqlite:///./test.db", "sqlite+aiosqlite:///./test.db"),
    ],
)
def test_database_url_normalization(url: str, expected: str) -> None:
    settings = Settings(_env_file=None, secret_key="x" * 32, database_url=url)
    assert settings.database_url == expected


def test_railway_deployment_configuration() -> None:
    config = json.loads((ROOT / "railway.json").read_text())
    assert config["build"].get("builder") != "DOCKERFILE"
    assert config["build"]["dockerfilePath"] == "backend/Dockerfile"
    assert config["deploy"]["healthcheckPath"] == "/healthz"
    assert config["deploy"]["numReplicas"] == 1


@pytest.mark.parametrize(("port", "expected"), [(None, "8000"), ("4321", "4321")])
@pytest.mark.parametrize("migration_status", [0, 1])
def test_container_startup(tmp_path: Path, port: str | None, expected: str, migration_status: int) -> None:
    dockerfile = (ROOT / "backend/Dockerfile").read_text()
    command = json.loads(next(line[4:] for line in dockerfile.splitlines() if line.startswith("CMD ")))
    venv_bin = tmp_path / "bin"
    venv_bin.mkdir()
    alembic = venv_bin / "alembic"
    alembic.write_text(f"#!/bin/sh\nexit {migration_status}\n")
    uvicorn = venv_bin / "uvicorn"
    uvicorn.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
    alembic.chmod(0o755)
    uvicorn.chmod(0o755)
    command[2] = command[2].replace("/app/backend/.venv/bin", str(venv_bin))
    env = {**os.environ, "PATH": os.defpath}
    env.pop("PORT", None)
    if port is not None:
        env["PORT"] = port
    result = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
    assert result.returncode == migration_status
    if migration_status:
        assert result.stdout == ""
    else:
        assert result.stdout.splitlines() == ["app.main:app", "--host", "0.0.0.0", "--port", expected, "--ws-max-size", "1048576"]
