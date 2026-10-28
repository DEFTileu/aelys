# Aelys Git Workflow

This is the canonical contribution and commit policy for Aelys. It applies to
human contributors, Codex, Claude Code, and parallel agents.

## Branches and ownership

- Keep `main` stable.
- Use descriptive branches such as `feat/offline-sync`, `fix/calendar-timezone`,
  or `docs/contributing-guide`.
- The lead agent owns integration and the shared Git index.
- Each parallel agent owns a disjoint file/module set. Use isolated worktrees
  when parallel work requires Git operations.
- Do not let multiple agents stage or commit concurrently.
- Never overwrite unknown working-tree changes. Do not use `git reset --hard`,
  `git clean -fd`, force-push, or destructive history rewriting without explicit
  authorization.

## Conventional Commits

Every commit subject follows:

```text
type(scope): imperative description
```

Allowed lowercase types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`,
`build`, `ci`, `chore`, and `security`.

Keep the subject in English, concise, preferably under 72 characters, and state
what changed. Use a body when the reason, tradeoff, or migration impact needs
to be recorded. Use a `BREAKING CHANGE:` footer for incompatible behavior.

Examples:

```text
feat(sync): add device acknowledgement cursors
fix(auth): reject replayed refresh tokens
test(agent): cover credential lease replay
docs(setup): document local PostgreSQL validation
```

Avoid vague subjects such as `update files`, `changes`, `implementation`, or
`agent changes`.

## Atomic commits and timing

One commit represents one coherent logical change. Keep implementation,
regression tests, migrations, and required contract documentation together when
they form one reviewable feature. Separate unrelated modules and maintenance.

Commit at meaningful milestones: a working endpoint with tests, a migration and
its compatibility checks, a validated runtime component, or a completed
documentation change. Do not commit knowingly broken work unless the incomplete
state is explicitly documented as a spike.

## Before every commit

1. Inspect `git status` and the complete diff.
2. Identify the files belonging to the current logical change.
3. Run the narrowest relevant tests, then required type, lint, security, and
   integration checks.
4. Fix failures caused by the change.
5. Stage explicit paths only; never use a blanket `git add .` in a mixed agent
   worktree.
6. Review `git diff --cached` and confirm no secrets, local databases, private
   sessions, build outputs, or unrelated agent work is staged.
7. Create the Conventional Commit without bypassing hooks.
8. Verify the commit subject, commit contents, and remaining working-tree state.

If validation cannot run, document the exact command and reason in the handoff
or pull request. Never claim a check passed unless it ran successfully.

## Repository hygiene

Never commit API keys, access tokens, passwords, secret `.env` files, local
databases, private user data, Claude/Codex authentication data, full agent
sessions, machine-specific paths, temporary debugging files, or unnecessary
build artifacts. Keep lockfiles required for reproducible builds. Commit
generated files only when they are an intentional source or distribution
artifact, such as the checked-in OpenAPI specification.

## Pull requests

Use the repository pull request template. A pull request must state the problem,
the resulting behavior, implementation decisions, validation commands, risks,
and breaking changes. Do not invent issue identifiers. Do not push, merge, or
publish releases without explicit authorization.

## End-of-task report

Report:

1. What was implemented.
2. Commits created, with short hashes and subjects.
3. Tests and quality checks actually executed.
4. Remaining uncommitted changes, especially work owned by other agents.
5. Known blockers and deferred decisions.
