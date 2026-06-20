import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShipSilentlyClient } from './index';

describe('ShipSilently SDK — analytics buffering & flushing', () => {
  it('records evaluations and flushes them to /v1/analytics/events', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/evaluate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
        } as unknown as Response;
      }
      if (url.endsWith('/v1/analytics/events')) {
        return { ok: true, status: 200, json: async () => ({ accepted: 1 }) } as unknown as Response;
      }
      return { ok: false, status: 500 } as Response;
    });

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { flushIntervalMs: 60_000, maxBatchSize: 100 },
    });

    await client.evaluate('a', {}, false);
    expect(client._bufferSize()).toBe(1);

    const flushed = await client.flushAnalytics();
    expect(flushed).toBe(1);
    expect(client._bufferSize()).toBe(0);

    const lastCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/v1/analytics/events'));
    expect(lastCall).toBeDefined();
    const body = JSON.parse((lastCall![1] as RequestInit).body as string);
    expect(body.events[0].flagKey).toBe('a');
    expect(body.events[0].variationKey).toBe('true');
    expect(body.events[0].reason).toBe('default');
  });

  it('auto-flushes once the buffer hits maxBatchSize', async () => {
    const flushSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accepted: 2 }),
    } as unknown as Response);
    const evalSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
    } as unknown as Response);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/analytics/events')) return flushSpy(url);
      return evalSpy(url);
    });

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { flushIntervalMs: 60_000, maxBatchSize: 2 },
    });

    await client.evaluate('a', {}, false);
    await client.evaluate('a', {}, false);

    // Wait a microtask for the auto-flush to fire.
    await new Promise((r) => setTimeout(r, 5));
    expect(flushSpy).toHaveBeenCalled();
  });

  it('honors enabled=false by skipping all buffering', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
    } as unknown as Response);
    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { enabled: false },
    });

    await client.evaluate('a', {}, false);
    expect(client._bufferSize()).toBe(0);
    const flushed = await client.flushAnalytics();
    expect(flushed).toBe(0);
  });

  it('drops oldest events when the buffer exceeds maxBufferSize', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
    } as unknown as Response));

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: {
        flushIntervalMs: 60_000,
        maxBatchSize: 1_000,
        maxBufferSize: 3,
      },
    });

    // Drive the internal recorder directly so we can verify the bound.
    for (let i = 0; i < 10; i++) {
      client.recordEvaluation({
        flagKey: 'flag',
        variationKey: 'true',
        reason: 'default',
        latencyMs: 1,
        timestamp: 0,
      });
    }
    expect(client._bufferSize()).toBeLessThanOrEqual(3);
  });

  it('records variation keys consistently across get() and evaluate()', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flags: {
          'priming': { flagKey: 'priming', value: 'green', reason: 'rule_match' },
        },
      }),
    } as unknown as Response);

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { flushIntervalMs: 60_000, maxBatchSize: 100 },
    });

    await client.evaluateAll({ userId: 'u' });
    client.get('priming', '');

    expect(client._bufferSize()).toBeGreaterThan(0);
    // Capture the buffer contents by flushing and inspecting the request body.
    const flushFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accepted: 1 }),
    } as unknown as Response);
    (client as unknown as { fetch: typeof globalThis.fetch }).fetch = flushFetch as unknown as typeof globalThis.fetch;

    await client.flushAnalytics();
    const body = JSON.parse((flushFetch.mock.calls[0]![1] as RequestInit).body as string);
    const variations = body.events.map((e: { variationKey: string }) => e.variationKey);
    // Every variation key must be a JSON-encoded "green" string.
    expect(variations.every((v: string) => v === '"green"')).toBe(true);
  });

  it('re-buffers a throttled (429) flush so metrics are not lost', async () => {
    // A rate-limited flush must NOT drop events — otherwise a busy client
    // silently loses metrics and the dashboard stays empty.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/analytics/events')) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: 'rate_limit_exceeded' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
      } as unknown as Response;
    });

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { flushIntervalMs: 60_000, maxBatchSize: 100 },
    });

    await client.evaluate('a', {}, false);
    expect(client._bufferSize()).toBe(1);

    const flushed = await client.flushAnalytics();
    expect(flushed).toBe(0);
    // Events stay buffered for the next flush instead of being dropped.
    expect(client._bufferSize()).toBe(1);
  });

  it('drops events on a hard 4xx (400) — replay cannot succeed', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/analytics/events')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_payload' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ flagKey: 'a', value: true, reason: 'default' }),
      } as unknown as Response;
    });

    const client = new ShipSilentlyClient({
      apiKey: 'k',
      apiUrl: 'http://localhost',
      fetch: fetchMock as typeof globalThis.fetch,
      analytics: { flushIntervalMs: 60_000, maxBatchSize: 100 },
    });

    await client.evaluate('a', {}, false);
    expect(client._bufferSize()).toBe(1);

    const flushed = await client.flushAnalytics();
    expect(flushed).toBe(0);
    // A malformed batch is dropped so it can't grow the buffer unbounded.
    expect(client._bufferSize()).toBe(0);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });
});
