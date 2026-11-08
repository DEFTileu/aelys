import { expect, it } from 'vitest'
import { createNativeFetchFromInvoke } from '../lib/nativeClient'
import type { NativeInvoke } from '../lib/nativeTransport'

it('preserves the conversation receipt key through native IPC without sending auth headers', async () => {
  const operations: unknown[] = []
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
    operations.push(args?.operation)
    return { id: 'conversation-1' } as T
  }
  const fetcher = createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')
  await fetcher('http://127.0.0.1:8000/api/v1/ai/conversations', {
    method: 'POST', headers: { 'Idempotency-Key': 'conversation-1', Authorization: 'must-stay-in-client' },
    body: JSON.stringify({ title: 'Plan' }),
  })
  expect(operations).toEqual([{ type: 'ai_conversation_create', conversation: { title: 'Plan' }, idempotency_key: 'conversation-1' }])
})

it('routes the authenticated server capability probe through the typed native operation', async () => {
  const operations: unknown[] = []
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
    operations.push(args?.operation)
    return { conversation_create_idempotency: true } as T
  }
  const fetcher = createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')
  const response = await fetcher('http://127.0.0.1:8000/api/v1/ai/capabilities')
  expect(await response.json()).toEqual({ conversation_create_idempotency: true })
  expect(operations).toEqual([{ type: 'ai_capabilities' }])
})
