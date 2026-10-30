from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import StrEnum

from fastapi import APIRouter, Depends
from pydantic import Field, field_validator, model_validator
from sqlalchemy import Numeric, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .common import (
    APIModel,
    OwnerScoped,
    db_dependency,
    get_owned,
    owner_dependency,
    save,
)


class MoneyType(StrEnum):
    income = "income"
    expense = "expense"
    transfer = "transfer"


class FinanceAccount(OwnerScoped):
    __tablename__ = "finance_accounts"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    account_type: Mapped[str] = mapped_column(String(40), default="cash", nullable=False)
    is_archived: Mapped[bool] = mapped_column(default=False, nullable=False)


class FinanceCategory(OwnerScoped):
    __tablename__ = "finance_categories"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category_type: Mapped[str] = mapped_column(String(20), default="expense", nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class FinanceTransaction(OwnerScoped):
    __tablename__ = "finance_transactions"
    account_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    category_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    transaction_type: Mapped[str] = mapped_column(String(20), nullable=False)
    occurred_on: Mapped[date] = mapped_column(nullable=False, index=True)
    related_transfer_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)


class FinanceBudget(OwnerScoped):
    __tablename__ = "finance_budgets"
    category_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    period_start: Mapped[date] = mapped_column(nullable=False)
    period_end: Mapped[date] = mapped_column(nullable=False)
    limit_amount: Mapped[Decimal] = mapped_column(Numeric(20, 4), nullable=False)


class AccountCreate(APIModel):
    name: str = Field(min_length=1, max_length=200); currency: str = Field(min_length=3, max_length=3); account_type: str = "cash"
    @field_validator("currency")
    @classmethod
    def upper(cls, v: str) -> str: return v.upper()


class CategoryCreate(APIModel):
    name: str = Field(min_length=1, max_length=200); category_type: str = "expense"; parent_id: str | None = None


class TransactionCreate(APIModel):
    account_id: str; category_id: str | None = None; amount: Decimal; currency: str = Field(min_length=3, max_length=3); transaction_type: MoneyType; occurred_on: date; related_transfer_id: str | None = None; notes: str | None = None; idempotency_key: str = Field(min_length=1, max_length=100)
    @field_validator("amount", mode="before")
    @classmethod
    def amount_decimal(cls, v):
        if isinstance(v, float): raise ValueError("amount must be decimal or string")  # noqa: TRY004 - Pydantic needs ValueError for structured money validation
        value=Decimal(str(v))
        if value == 0: raise ValueError("amount cannot be zero")
        return value
    @field_validator("currency")
    @classmethod
    def upper(cls, v: str) -> str: return v.upper()


class BudgetCreate(APIModel):
    category_id: str | None = None; currency: str = Field(min_length=3, max_length=3); period_start: date; period_end: date; limit_amount: Decimal
    @model_validator(mode="after")
    def valid(self):
        if self.period_end < self.period_start: raise ValueError("period_end must be after period_start")
        if self.limit_amount < 0: raise ValueError("limit_amount cannot be negative")
        return self


class AccountOut(APIModel):
    id: str; owner_id: str; name: str; currency: str; account_type: str; is_archived: bool; version: int


class CategoryOut(APIModel):
    id: str; owner_id: str; name: str; category_type: str; parent_id: str | None; version: int


class TransactionOut(APIModel):
    id: str; owner_id: str; account_id: str; category_id: str | None; amount: Decimal; currency: str; transaction_type: MoneyType; occurred_on: date; related_transfer_id: str | None; notes: str | None; idempotency_key: str; version: int


class BudgetOut(APIModel):
    id: str; owner_id: str; category_id: str | None; currency: str; period_start: date; period_end: date; limit_amount: Decimal; version: int


router = APIRouter(prefix="/api/v1/finance", tags=["finance"])


@router.post("/accounts", response_model=AccountOut, status_code=201)
def create_account(p: AccountCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return save(db, FinanceAccount(owner_id=owner_id, **p.model_dump()))


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return list(db.scalars(select(FinanceAccount).where(FinanceAccount.owner_id==owner_id,FinanceAccount.deleted_at.is_(None))))


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(p: CategoryCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return save(db,FinanceCategory(owner_id=owner_id,**p.model_dump()))


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return list(db.scalars(select(FinanceCategory).where(FinanceCategory.owner_id==owner_id,FinanceCategory.deleted_at.is_(None))))


@router.post("/transactions", response_model=TransactionOut, status_code=201)
def create_transaction(p: TransactionCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    get_owned(db,FinanceAccount,p.account_id,owner_id)
    existing=db.scalar(select(FinanceTransaction).where(FinanceTransaction.owner_id==owner_id,FinanceTransaction.idempotency_key==p.idempotency_key))
    if existing: return existing
    return save(db,FinanceTransaction(owner_id=owner_id,**p.model_dump()))


@router.get("/transactions", response_model=list[TransactionOut])
def list_transactions(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return list(db.scalars(select(FinanceTransaction).where(FinanceTransaction.owner_id==owner_id,FinanceTransaction.deleted_at.is_(None)).order_by(FinanceTransaction.occurred_on.desc())))


@router.post("/budgets", response_model=BudgetOut, status_code=201)
def create_budget(p: BudgetCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return save(db,FinanceBudget(owner_id=owner_id,**p.model_dump()))


@router.get("/budgets", response_model=list[BudgetOut])
def list_budgets(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return list(db.scalars(select(FinanceBudget).where(FinanceBudget.owner_id==owner_id,FinanceBudget.deleted_at.is_(None))))
