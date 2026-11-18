import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client';

describe('live system monitoring', () => {
  it('fetches status anew and never falls back to a previous success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ api: 'ok', database: 'ok', checked_at: '2026-11-18T00:00:00Z', uptime_seconds: 10 }), { headers: { 'Content-Type': 'application/json' } })).mockRejectedValueOnce(new Error('offline'));
    const client = new ApiClient({ baseUrl: 'https://example.test', fetch: fetcher, readFreshnessMs: 60_000 });
    expect((await client.getSystemStatus()).database).toBe('ok');
    await expect(client.getSystemStatus()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads bounded audit events from the authenticated system endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'https://example.test', token: 'test-token', fetch: fetcher });
    expect(await client.getSystemEvents(20)).toEqual({ items: [] });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://example.test/api/v1/system/events?limit=20');
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer test-token');
  });
});
