import pytest
from app.ai.errors import BudgetExceeded, ModelUnavailable, ProviderError
from app.integrations.telegram_command_errors import error_code, notice
from fastapi import HTTPException


@pytest.mark.parametrize('exc,code', [
    (BudgetExceeded('private prompt'), 'BUDGET_EXCEEDED'),
    (ModelUnavailable('sk-secret-token'), 'MODEL_UNAVAILABLE'),
    (ProviderError('private provider body'), 'PROVIDER_ERROR'),
    (HTTPException(409, {'code': 'TELEGRAM_REPLY_DENIED'}), 'TELEGRAM_REPLY_DENIED'),
    (HTTPException(500, {'code': ['untrusted']}), 'COMMAND_FAILED'),
    (HTTPException(500, {'code': 'sk-secret-token'}), 'COMMAND_FAILED'),
    (RuntimeError('private prompt sk-secret-token'), 'COMMAND_FAILED'),
])
def test_safe_error_classification(exc, code):
    assert error_code(exc) == code
    message = notice(code, 'reference-123')
    assert code in message and 'reference-123' in message
    assert 'private' not in message and 'sk-secret' not in message


def test_known_failures_have_distinct_actionable_notices():
    assert 'бюджет' in notice('BUDGET_EXCEEDED', '123').lower()
    assert 'модель' in notice('MODEL_UNAVAILABLE', '123').lower()
    assert 'разреш' in notice('TELEGRAM_REPLY_DENIED', '123').lower()
    assert 'неизвестен' in notice('TELEGRAM_DELIVERY_UNKNOWN', '123')
    assert 'не отправлен' not in notice('TELEGRAM_DELIVERY_UNKNOWN', '123')
    assert 'sk-secret' not in notice('sk-secret', '123')
