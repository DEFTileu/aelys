PYTHON=.venv/bin/python

test:
	PYTHONPATH=backend $(PYTHON) -m pytest -q backend/tests

compile:
	PYTHONPATH=backend $(PYTHON) -m compileall -q backend/app

migrate:
	cd backend && PYTHONPATH=. ../$(PYTHON) -m alembic upgrade head

openapi:
	tmp=$$(mktemp); trap 'rm -f "$$tmp"' EXIT; AELYS_SECRET_KEY="$${AELYS_SECRET_KEY:?set AELYS_SECRET_KEY}" PYTHONPATH=backend $(PYTHON) -c 'from app.main import app; import json; print(json.dumps(app.openapi(), indent=2))' > "$$tmp"; PYTHONPATH=backend $(PYTHON) -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value.get("paths"), "OpenAPI paths are empty"' "$$tmp"; mv "$$tmp" docs/openapi.json
