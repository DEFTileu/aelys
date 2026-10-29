# Contributing to Aelys

Thank you for contributing to Aelys. Read [AGENTS.md](AGENTS.md) for repository
architecture and security constraints, then read
[docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md) for the canonical branch, commit,
validation, and pull request policy.

## Before changing code

Read the relevant project documents under `docs/`, inspect `git status`, and
choose one milestone or task from `docs/IMPLEMENTATION_PLAN.md`. Preserve
unrelated working-tree changes, including changes made by other agents.

## Validation

Run checks appropriate to the files changed. The backend CI checks Python
compilation, pytest, mypy, Ruff, Bandit, pip-audit, Alembic migrations,
PostgreSQL integration, and OpenAPI drift. The runtime CI checks rustfmt, Cargo
tests, and Clippy. Record exact commands and results in the pull request.

## Security and privacy

Never commit secrets or full Claude/Codex sessions. Agent transcripts, prompts,
commands, paths, snippets, and embeddings remain local to the Mac runtime.
Do not weaken authentication, sandbox, policy, provenance, or fail-closed
vendor-execution gates to make a test pass.

## Commits and pull requests

Use atomic Conventional Commits, for example:

```text
feat(sync): add device acknowledgement cursors
```

Stage explicit paths, review the staged diff, and use the pull request template.
Do not rewrite published history or push directly to protected branches.
