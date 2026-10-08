# Common tasks. On Windows without make, run the commands after each target directly.
PY ?= .venv/bin/python
ifeq ($(OS),Windows_NT)
PY = .venv/Scripts/python
endif
GL = $(PY) -m gaugelab.cli

.PHONY: setup web seed demo demo-fresh serve dev agent test test-py test-web e2e lint typecheck ci ci-regression docker clean

setup:            ## virtualenv + Python deps + web deps
	python -m venv .venv
	$(PY) -m pip install -e ".[dev,pdf]"
	cd apps/web && npm ci

web:              ## build the web app (served by the API)
	cd apps/web && npm run build

seed:             ## migrate and load the Acme demo (dataset, targets, gate)
	$(GL) seed

demo:             ## seed + run baseline and candidate (zero API cost)
	$(GL) seed --run

demo-fresh:       ## an empty database with three weeks of demo history (stop the server first): a clean slate for a live demo
	$(GL) seed --run --history --fresh

serve:            ## API + built web app on http://localhost:8040
	$(GL) serve --port 8040

agent:            ## the Acme demo agent over HTTP on :9040
	$(GL) demo-agent --port 9040

dev:              ## API on :8040 and Vite with hot reload on :5240 (two processes)
	$(GL) serve --port 8040 & cd apps/web && npm run dev

test: test-py test-web

test-py:
	$(PY) -m pytest -q

test-web:
	cd apps/web && npm test

e2e:              ## Playwright flows on a fresh seeded server (:8041)
	cd apps/web && npx playwright test

lint:
	$(PY) -m ruff check gaugelab apps/api tests examples conftest.py
	cd apps/web && npm run lint

typecheck:
	$(PY) -m mypy
	cd apps/web && npm run typecheck

ci:               ## the CI regression gate locally: baseline vs candidate, exits 1 on FAIL
	$(GL) ci benchmarks/acme_support/ci.yaml

ci-regression:    ## same gate against a deliberately regressed candidate: must FAIL
	$(GL) ci benchmarks/acme_support/ci-regression.yaml

docker:
	docker compose up --build

clean:
	rm -rf data gaugelab-artifacts apps/web/dist
