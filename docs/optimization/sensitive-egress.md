# Sensitive data egress guard

The AI provider boundary rejects the **entire request** when deterministic local
inspection finds a likely credential or personal identifier. It does not redact
a match and continue. The check runs on the original request before untrusted
text handling can redact token-like strings, and again on each provider-ready
JSON payload immediately before completion or streaming HTTP I/O. Configured
provider credentials are also checked against the payload as exact known values.
Blocked errors contain no matched content.

Inspection covers text messages, system and assistant history, structured tool
arguments/results, tool schemas and descriptions, model identifiers, and
retrieved text (including already-redacted retrieval markers). It includes
common API keys, passwords/tokens, email/phone and selected government/payment
identifiers. This is a deterministic pattern check, not a semantic privacy
classifier; it can miss sensitive prose and can conservatively reject benign
text that resembles a credential.

Inline media bytes are intentionally not decoded or regex-scanned. Binary
attachments therefore have no sensitive-content classification guarantee from
this guard. Existing provider media handling remains in effect, and the guard
still checks their accompanying text and all other JSON payload fields.
