"""Store encrypted Gmail credentials and single-use OAuth state."""
from alembic import op
from sqlalchemy import inspect
from app.core.models import GmailCredential, GmailDraftLink, GmailOAuthState

revision = "0016_gmail_connection"
down_revision = "0015_finance_transfer_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    for table in (GmailCredential.__table__, GmailOAuthState.__table__, GmailDraftLink.__table__):
        if table.name not in inspect(bind).get_table_names():
            table.create(bind)


def downgrade() -> None:
    for table in (GmailDraftLink.__table__, GmailOAuthState.__table__, GmailCredential.__table__):
        op.drop_table(table.name)
