"""Parse a bounded EML import into plain text without executing HTML or links."""
from datetime import UTC, datetime
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime

from fastapi import HTTPException


def parse_eml(raw: bytes) -> dict:
    message = BytesParser(policy=policy.default).parsebytes(raw)
    sender = str(message.get("From", "")).strip()
    if not sender:
        raise HTTPException(422, detail={"code": "INVALID_EML", "message": "EML must contain a From header"})
    body_part = message.get_body(preferencelist=("plain",))
    body = body_part.get_content() if body_part is not None else ""
    if not isinstance(body, str):
        body = ""
    if not body and message.get_body(preferencelist=("html",)) is not None:
        raise HTTPException(422, detail={"code": "UNSUPPORTED_EML", "message": "Import a message with a plain text body"})
    try:
        received = parsedate_to_datetime(str(message.get("Date", "")))
        if received.tzinfo is None:
            received = received.replace(tzinfo=UTC)
    except (ValueError, TypeError, OverflowError):
        received = datetime.now(UTC)
    return {
        "sender": sender[:320],
        "recipients": [address for _, address in getaddresses([str(message.get("To", ""))])],
        "subject": str(message.get("Subject", "(No subject)"))[:500],
        "body": body,
        "received_at": received,
        "sync_origin": "eml_import",
    }
