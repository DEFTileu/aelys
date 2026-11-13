# Curated Knowledge for contact-facing agent commands

This small retrieval service supplies general, shareable facts to contact-facing
commands. It does not read tasks, calendar entries, mail, agent sessions, or
source code. It does not learn or save facts from conversations.

## Add a shareable note

1. In **Notes**, create a note with the facts you intend to share with a contact.
   From **Knowledge**, **New document** opens the same note editor.
2. Add the exact tag `agent-context` in the note's tag field and save the note.
   Tag matching is case-sensitive; `Agent-context` and similar tags do not opt in.
3. In **Knowledge**, choose **Manage sources**, select the note, then choose
   **Enable for AI**.

Both the tag and **Enable for AI** are required. The tag identifies this narrow
shareable context, while the existing `knowledge_enabled` setting records
consent to AI use. Removing either immediately makes the note ineligible.
Editing a note changes its version, so prior source references become stale.
Deleting a note also makes its references stale.

Write notes as intentionally shareable summaries. For example:

> Aelys is my personal open-source project: an offline-first personal system for
> one user. The web app uses React and TypeScript, the backend uses Python and
> FastAPI, and the macOS app uses Tauri 2 and Rust. Aelys is still in progress;
> this description does not mean every planned feature has passed acceptance
> or shipped.

Do not put private tasks, calendar details, mail contents, code, local paths, or
line references in these notes. This is a curation rule: retrieval does not run
a classifier that can reliably detect every private or code-like passage.

## Built-in Aelys card

The service also has one fixed, transparent card, available only when the query
mentions `Aelys`, `аелис`, or `элис` (case-insensitive). Its excerpt is:

> Aelys is the owner's personal, open-source project. Its intended product is a
> single-user, offline-first personal system. The web application uses React and
> TypeScript; the backend uses Python and FastAPI; the macOS application uses
> Tauri 2 and Rust, with PostgreSQL in the server stack. Aelys is still in
> progress. This short project description does not establish that every planned
> capability has passed acceptance or shipped.

This is a brief project summary, not a complete product specification or an
acceptance claim. General technical questions without an Aelys name alias do
not retrieve this card.

## Retrieval and provenance

Retrieval returns up to six sources, with excerpts of at most 1,600 characters
each. The eligible note scan is capped at 100 candidates and 4 MB of candidate
text; exceeding either limit fails closed with `KNOWLEDGE_CANDIDATE_LIMIT` rather
than returning a possibly incomplete subset. Matching is lexical and bounded;
it is not semantic search. The service checks `knowledge.read` through the
server Policy Engine and returns only the source ID, version, title, and excerpt.

Before using a retrieved result, callers must JSON-encode it as untrusted input
and validate every `{id, version}` reference with `current` (up to 70 inherited references; the six-source limit applies to each retrieval). The built-in card
uses the stable reference `builtin:aelys` at version `1`. For notes, freshness
requires the same owner, a live note, the exact tag, AI consent, and the same
version for every reference.
