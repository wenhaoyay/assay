# Contributing to Assay

Assay is a local-first RAG and agent evaluation workbench. Contributions that preserve transparent evaluation and reproducible results are welcome.

## Set up and validate

Use Python 3.12+ and Node.js 22+. From the repository root:

```sh
python -m pip install -e ".[dev,pdf]"
python -m pytest -q
python -m ruff check assay apps/api tests examples conftest.py
python -m mypy
```

For the web app, from `apps/web`:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The repository's GitHub Actions workflow also tests PostgreSQL migrations, a zero-cost regression gate, and Playwright browser flows.

## Keep contributions safe to publish

- Use only fictional or explicitly authorized data in test fixtures, docs, examples, and screenshots. Do not copy material from an employer, client, private system, internal handbook, or real chat log.
- Do not commit credentials, personal email addresses, access tokens, local databases, captured HTTP responses, exported evaluations, or unreviewed screenshots. Keep private connector settings in ignored local files.
- Check **the entire diff and commit messages**, not just final files. Deleting a secret later does not erase it from Git history.
- New sample cases should be reproducible and based on the included fictional demo, not information from an actual organization.
- Do not weaken evaluators, gate behavior, or privacy restrictions merely to make tests pass. Add a regression test that covers any fix.
- Documentation must distinguish synthetic benchmark results from tests with a real, independently running model.

For deployment limits and responsible disclosure, see [Security policy](SECURITY.md).
