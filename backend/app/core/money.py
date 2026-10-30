"""Exact Decimal persistence on PostgreSQL and the local SQLite backend."""
from decimal import Decimal

from sqlalchemy import Numeric, String
from sqlalchemy.types import TypeDecorator


class ExactMoney(TypeDecorator[Decimal]):
    """SQLite NUMERIC affinity silently converts decimal strings to binary floats."""
    impl = Numeric(20, 4)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(String(40) if dialect.name == "sqlite" else Numeric(20, 4))

    def process_bind_param(self, value: Decimal | None, dialect):
        if value is None:
            return None
        if isinstance(value, float):
            raise TypeError("Money must never be bound as a float")
        decimal = Decimal(value)
        return str(decimal) if dialect.name == "sqlite" else decimal

    def process_result_value(self, value, dialect) -> Decimal | None:
        return None if value is None else Decimal(value)
