"""Upgrade a previously paired companion without losing v1.1 state."""
import os
from pathlib import Path

import pytest
import sqlalchemy as sa
from app.companion.models import CompanionState
from app.companion.ota_models import CompanionCoredump, CompanionFirmware
from app.core.models import Device, User
from test_clean_migrations import run_alembic


@pytest.mark.parametrize("backend", ["sqlite", "postgresql"])
def test_ota_upgrade_preserves_companion_state(backend: str, tmp_path: Path) -> None:
    if backend == "postgresql":
        url = os.environ.get("AELYS_TEST_POSTGRES_COMPANION_MIGRATION_URL")
        if not url:
            pytest.skip("set AELYS_TEST_POSTGRES_COMPANION_MIGRATION_URL to an empty disposable database")
        parsed = sa.engine.make_url(url)
        assert parsed.get_backend_name() == "postgresql"
        sync_url = parsed.set(drivername="postgresql+psycopg")
    else:
        url = f"sqlite+aiosqlite:///{tmp_path / 'companion-upgrade.db'}"
        sync_url = sa.engine.make_url(url).set(drivername="sqlite")
    engine = sa.create_engine(sync_url, poolclass=sa.pool.NullPool)
    try:
        inspector = sa.inspect(engine)
        assert not inspector.get_table_names() and not inspector.get_view_names(), "test database must be empty"
        run_alembic(url, "upgrade", "0054_telegram_command_sessions")
        # 0001 creates current metadata; remove only new empty tables in this
        # disposable DB to reproduce the actual schema deployed before OTA.
        with engine.begin() as connection:
            CompanionCoredump.__table__.drop(connection, checkfirst=True)
            CompanionFirmware.__table__.drop(connection, checkfirst=True)
            connection.execute(sa.insert(User).values(id="ota-test-owner", settings_json={"retained": True}))
            connection.execute(sa.insert(Device).values(
                id="ota-test-device", owner_id="ota-test-owner", platform="companion",
                display_name="Migration fixture", public_key="fixture-key", credential_hash="fixture-hash",
            ))
            connection.execute(sa.insert(CompanionState).values(
                device_id="ota-test-device", owner_id="ota-test-owner", fw_version="0.1.0",
                wifi_json={"saved": ["fixture-network"]}, settings_json={"brightness": 65},
            ))
        run_alembic(url, "upgrade", "head")
        # The migration is inspector-guarded: replay against the existing schema.
        run_alembic(url, "stamp", "0054_telegram_command_sessions")
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        with engine.begin() as connection:
            assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == "0055_companion_firmware"
            state = connection.execute(sa.select(CompanionState.__table__)).mappings().one()
            assert state["wifi_json"] == {"saved": ["fixture-network"]}
            assert state["settings_json"] == {"brightness": 65}
            assert connection.scalar(sa.select(Device.public_key)) == "fixture-key"
            connection.execute(sa.insert(CompanionFirmware).values(
                owner_id="ota-test-owner", version="0.2.0", min_version="0.1.0",
                sha256="a" * 64, size=4, data=b"\x00\xff\x80\x01",
            ))
            assert connection.scalar(sa.select(CompanionFirmware.data)) == b"\x00\xff\x80\x01"
        run_alembic(url, "downgrade", "0054_telegram_command_sessions")
        assert not sa.inspect(engine).has_table("companion_firmware")
        assert not sa.inspect(engine).has_table("companion_coredumps")
        with engine.connect() as connection:
            assert connection.scalar(sa.select(Device.public_key)) == "fixture-key"
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
