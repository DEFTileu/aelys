import re
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ChatCommand:
    kind: Literal["ask", "search", "new"]
    query: str
    quote: str | None


_COMMAND = re.compile(
    r"^\s*(?:/\s*(?P<slash_kind>ask|search|new)|(?P<plain_kind>ask|search))"
    r"(?:@(?P<bot>[A-Za-z0-9_]+))?(?=$|\s)",
    re.IGNORECASE,
)


def parse_chat_command(
    text: str, *, bot_username: str, quote: str | None = None
) -> ChatCommand | None:
    match = _COMMAND.match(text)
    if match is None:
        return None

    mentioned_bot = match.group("bot")
    if mentioned_bot is not None and mentioned_bot.casefold() != bot_username.lstrip("@").casefold():
        return None
    if len(text) > 4096:
        raise ValueError("command text exceeds 4096 characters")

    rawcase = (match.group("slash_kind") or match.group("plain_kind")).casefold()
    kind: Literal["ask", "search", "new"] = "new" if rawcase == "new" else "ask" if rawcase == "ask" else "search"
    query = text[match.end() :].strip()
    if kind == "new":
        if query:
            raise ValueError("new command does not accept arguments")
        return ChatCommand(kind="new", query="", quote=None)
    usable_quote = quote if quote is not None and quote.strip() else None
    if not query:
        if usable_quote is None:
            raise ValueError("ask/search command needs a query or quoted text")
        query = (
            "Кратко объясни выбранный текст простыми словами."
            if kind == "ask"
            else "Найди информацию о выбранном тексте."
        )

    return ChatCommand(kind=kind, query=query, quote=quote)
