"""read only Google Calendar"""
import sqlalchemy as sa
from alembic import op

revision = '0034_google_calendar'
down_revision = '0033_task_work_timestamps'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('google_calendar_connections',
    sa.Column('calendar_id', sa.String(length=320), nullable=False),
    sa.Column('calendar_timezone', sa.String(length=64), nullable=False),
    sa.Column('connection_status', sa.String(length=32), nullable=False),
    sa.Column('encrypted_sync_token', sa.Text(), nullable=True),
    sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_attempt_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('lease_owner', sa.String(length=64), nullable=True),
    sa.Column('lease_expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error_code', sa.String(length=80), nullable=True),
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('owner_id', name='uq_google_calendar_owner')
    )
    op.create_index(op.f('ix_google_calendar_connections_owner_id'), 'google_calendar_connections', ['owner_id'], unique=False)
    op.create_table('google_calendar_credentials',
    sa.Column('connection_id', sa.String(length=36), nullable=False),
    sa.Column('encrypted_tokens', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['connection_id'], ['google_calendar_connections.id'], ),
    sa.PrimaryKeyConstraint('connection_id')
    )
    op.create_table('google_calendar_oauth_states',
    sa.Column('state_hash', sa.String(length=64), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('session_id', sa.String(length=36), nullable=False),
    sa.Column('encrypted_verifier', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['auth_sessions.id'], ),
    sa.PrimaryKeyConstraint('state_hash')
    )
    columns = {column['name'] for column in sa.inspect(op.get_bind()).get_columns('calendar_events')}
    for name, column in (
        ('external_source', sa.Column('external_source', sa.String(80), nullable=True)),
        ('external_id', sa.Column('external_id', sa.String(1024), nullable=True)),
        ('external_metadata', sa.Column('external_metadata', sa.JSON(), server_default='{}', nullable=False)),
    ):
        if name not in columns:
            op.add_column('calendar_events', column)
    constraints = {constraint['name'] for constraint in sa.inspect(op.get_bind()).get_unique_constraints('calendar_events')}
    if 'uq_calendar_event_external' not in constraints:
        with op.batch_alter_table('calendar_events') as batch:
            batch.create_unique_constraint('uq_calendar_event_external', ['external_source', 'external_id'])


def downgrade():
    with op.batch_alter_table('calendar_events') as batch:
        batch.drop_constraint('uq_calendar_event_external', type_='unique')
        batch.drop_column('external_metadata')
        batch.drop_column('external_id')
        batch.drop_column('external_source')
    op.drop_table('google_calendar_oauth_states')
    op.drop_table('google_calendar_credentials')
    op.drop_index(op.f('ix_google_calendar_connections_owner_id'), table_name='google_calendar_connections')
    op.drop_table('google_calendar_connections')
