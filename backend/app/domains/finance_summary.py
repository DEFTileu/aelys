"""Bounded-memory ledger totals without binary floating-point arithmetic."""
from decimal import Decimal
from typing import TypedDict

from app.core.models import FinanceTransaction
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession


class CurrencyTotals(TypedDict):
    currency: str
    balance: str
    income: str
    expense: str


class LedgerSummary(TypedDict):
    total: str | None
    count: int
    currencies: list[CurrencyTotals]


async def summarize_ledger(db: AsyncSession, owner_id: str) -> LedgerSummary:
    ledger = FinanceTransaction
    conditions = (ledger.owner_id == owner_id, ledger.deleted_at.is_(None))
    currencies: list[CurrencyTotals] = []
    count = 0
    if db.get_bind().dialect.name == "postgresql":
        # PostgreSQL NUMERIC aggregates stay exact and return one row per currency.
        magnitude = func.abs(ledger.amount)
        signed = case((ledger.type == "expense", -magnitude), (ledger.type == "income", magnitude), else_=ledger.amount)
        statement = select(
            ledger.currency,
            func.count().label("posting_count"),
            func.sum(signed).label("balance"),
            func.sum(case((ledger.type == "income", magnitude), else_=0)).label("income"),
            func.sum(case((ledger.type == "expense", magnitude), else_=0)).label("expense"),
        ).where(*conditions).group_by(ledger.currency).order_by(ledger.currency)
        for row in await db.execute(statement):
            count += row.posting_count
            currencies.append({"currency": row.currency, "balance": str(row.balance), "income": str(row.income), "expense": str(row.expense)})
    else:
        # SQLite stores ExactMoney as text. Native SUM/ABS would use floats.
        # Stream only these three columns; never load transaction notes or ORM entities.
        groups: dict[str, dict[str, Decimal]] = {}
        rows = await db.stream(select(ledger.currency, ledger.type, ledger.amount).where(*conditions).execution_options(yield_per=256))
        try:
            async for batch in rows.partitions():
                for currency, kind, amount in batch:
                    count += 1
                    group = groups.get(currency)
                    if group is None:
                        group = {"balance": Decimal(0), "income": Decimal(0), "expense": Decimal(0)}
                        groups[currency] = group
                    group["balance"] += -abs(amount) if kind == "expense" else abs(amount) if kind == "income" else amount
                    if kind in {"income", "expense"}:
                        group[kind] += abs(amount)
        finally:
            await rows.close()
        currencies = [{"currency": currency, "balance": str(group["balance"]), "income": str(group["income"]), "expense": str(group["expense"])} for currency, group in sorted(groups.items())]
    return {"total": currencies[0]["balance"] if len(currencies) == 1 else "0" if not currencies else None, "count": count, "currencies": currencies}
