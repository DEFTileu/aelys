"""0058 creates companion_weather on an existing install, keeps owner data, and can be rolled back."""
import sqlalchemy as sa
from test_clean_migrations import alembic_head, run_alembic


def test_existing_0057_database_gains_the_weather_table_and_keeps_the_owner(tmp_path):
    filename = tmp_path / "weather-upgrade.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0057_companion_character")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        with engine.begin() as db:  # the legacy bootstrap already creates current tables; drop ours to mimic a real 0057 install
            db.execute(sa.text("DROP TABLE IF EXISTS companion_weather"))
            db.execute(sa.text("INSERT INTO users (id,email,created_at,settings_json) VALUES ('preserved-owner','local',CURRENT_TIMESTAMP,'{}')"))
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        columns = {c["name"] for c in sa.inspect(engine).get_columns("companion_weather")}
        assert columns == {"owner_id", "name", "lat", "lon", "forecast_json", "fetched_at", "attempted_at"}
        with engine.begin() as db:
            assert db.scalar(sa.text("SELECT version_num FROM alembic_version")) == alembic_head()
            assert db.scalar(sa.text("SELECT email FROM users WHERE id='preserved-owner'")) == "local"
            db.execute(sa.text("INSERT INTO companion_weather (owner_id,name,lat,lon) VALUES ('preserved-owner','Testville',55.8,37.6)"))
        run_alembic(url, "downgrade", "0057_companion_character")
        assert not sa.inspect(engine).has_table("companion_weather")
        with engine.connect() as db:
            assert db.scalar(sa.text("SELECT email FROM users WHERE id='preserved-owner'")) == "local"
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
