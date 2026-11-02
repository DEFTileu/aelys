# Native AI run decimal response

Task: Phase 8, native/backend response contract regression.

The FastAPI ORM response encoded `cost_estimate` as a JSON number, while the
native transport and shared contract require a decimal string. A successful
creation could consequently be reported as `MUTATION_OUTCOME_UNKNOWN` after
the run had already been committed. Run creation, idempotent replay, retrieval
and cancellation now use an explicit response model that preserves decimal
precision as a JSON string. The existing native client needs no change.

Assumption: the shared `DecimalString` contract is authoritative. This fix
does not settle any OPEN product question.

Validation: `pytest -q tests/ai_automation --disable-warnings`: 49 passed,
7 skipped; Ruff passed for the changed Python files. The regression also
passed against the older staged Railway backend, but that staged deployment
could not start: the live database is already at revision
`0037_merge_telegram_knowledge`, which the old source does not contain.
The prior deployment remained available. The actual live API includes a
Telegram avatar route absent from the available repository checkouts, so the
exact live source must be recovered before preparing a safe deployment.
