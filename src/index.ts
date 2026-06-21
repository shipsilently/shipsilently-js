export type FlagValue = boolean | string | number | Record<string, unknown>;

export interface UserContext {
  userId?: string;
  email?: string;
  country?: string;
  plan?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface EvaluationResult {
  flagKey: string;
  value: FlagValue;
  reason: 'default' | 'rule_match' | 'rollout' | 'flag_disabled' | 'flag_not_found';
  ruleId?: string;
}

export interface AnalyticsConfig {
  /** Buffer + submit evaluation analytics. Defaults to true. */
  enabled?: boolean;
  /** Flush cadence in milliseconds. Defaults to 30_000ms. Min 1000ms. */
  flushIntervalMs?: number;
  /** Force a flush once buffered events reach this size. Defaults to 100. */
  maxBatchSize?: number;
  /** Drop events when the buffer exceeds this size. Defaults to 5000. */
  maxBufferSize?: number;
  /**
   * Sampling rate in [0, 1]. 1.0 = record every evaluation, 0.5 = record half.
   * Defaults to 1.0. Useful for very-high-throughput workloads where the
   * server-side aggregation already provides enough fidelity.
   */
  samplingRate?: number;
}

export interface ShipSilentlyConfig {
  apiKey: string;
  /** Defaults to the production ShipSilently API */
  apiUrl?: string;
  /** Override the fetch implementation — useful for testing */
  fetch?: typeof globalThis.fetch;
  /** Analytics submission settings — see AnalyticsConfig. */
  analytics?: AnalyticsConfig;
}

export type FlagsUpdateCallback = (flags: Record<string, EvaluationResult>) => void;

const DEFAULT_API_URL = 'https://shipsilently-cf.workers.dev';

interface PendingAnalyticsEvent {
  flagKey: string;
  variationKey: string;
  reason: string;
  latencyMs: number;
  timestamp: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 5_000;
const MIN_FLUSH_INTERVAL_MS = 1_000;

function variationKeyFromValue(value: FlagValue): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (raw.length > 200) raw = `${raw.slice(0, 197)}…`;
  return raw;
}

export class ShipSilentlyClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private cache: Record<string, EvaluationResult> = {};
  private analyticsConfig: Required<AnalyticsConfig>;
  private analyticsBuffer: PendingAnalyticsEvent[] = [];
  private analyticsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ShipSilentlyConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '');
    this.fetch = config.fetch ?? globalThis.fetch;
    this.analyticsConfig = {
      enabled: config.analytics?.enabled ?? true,
      flushIntervalMs: Math.max(
        MIN_FLUSH_INTERVAL_MS,
        config.analytics?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      ),
      maxBatchSize: config.analytics?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize: config.analytics?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      samplingRate: Math.min(1, Math.max(0, config.analytics?.samplingRate ?? 1)),
    };
    if (this.analyticsConfig.enabled) this.startAnalyticsTimer();
  }

  /**
   * Synchronous read from the local cache populated by `evaluateAll()` or `stream()`.
   * Returns `defaultValue` if the flag has not been evaluated yet.
   */
  get<T extends FlagValue>(flagKey: string, defaultValue: T): T {
    const startedAt = nowMs();
    const hit = this.cache[flagKey];
    const value = hit ? (hit.value as T) : defaultValue;
    this.recordEvaluation({
      flagKey,
      variationKey: variationKeyFromValue(value as FlagValue),
      reason: hit ? hit.reason : 'flag_not_found',
      latencyMs: nowMs() - startedAt,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return value;
  }

  /**
   * Snapshot of the current local flag cache.
   */
  getAll(): Record<string, EvaluationResult> {
    return { ...this.cache };
  }

  /**
   * Evaluate a single feature flag for a user context.
   * Returns `defaultValue` if the flag is not found or a network error occurs.
   */
  async evaluate<T extends FlagValue>(flagKey: string, context: UserContext, defaultValue: T): Promise<T> {
    const startedAt = nowMs();
    try {
      const res = await this.fetch(`${this.apiUrl}/v1/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({ flagKey, context }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(
            `[ShipSilently] Authentication failed (${res.status}) for flag "${flagKey}". Check your API key.`,
          );
        }
        // Server-side already records the auth failure as a 4xx — no client
        // event for failed auth, but we do record a "default" outcome so the
        // local-side latency for the failure shows up in the metrics.
        this.recordEvaluation({
          flagKey,
          variationKey: variationKeyFromValue(defaultValue as FlagValue),
          reason: 'flag_not_found',
          latencyMs: nowMs() - startedAt,
          timestamp: Math.floor(Date.now() / 1000),
        });
        return defaultValue;
      }
      const data = await res.json() as EvaluationResult;
      this.recordEvaluation({
        flagKey: data.flagKey,
        variationKey: variationKeyFromValue(data.value),
        reason: data.reason,
        latencyMs: nowMs() - startedAt,
        timestamp: Math.floor(Date.now() / 1000),
      });
      return data.value as T;
    } catch {
      this.recordEvaluation({
        flagKey,
        variationKey: variationKeyFromValue(defaultValue as FlagValue),
        reason: 'flag_not_found',
        latencyMs: nowMs() - startedAt,
        timestamp: Math.floor(Date.now() / 1000),
      });
      return defaultValue;
    }
  }

  /**
   * Evaluate all flags for a user context in a single network call.
   */
  async evaluateAll(context: UserContext): Promise<Record<string, EvaluationResult>> {
    const startedAt = nowMs();
    try {
      const res = await this.fetch(`${this.apiUrl}/v1/evaluate/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({ context }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(
            `[ShipSilently] Authentication failed (${res.status}) for evaluateAll. Check your API key.`,
          );
        }
        return {};
      }
      const data = await res.json() as { flags: Record<string, EvaluationResult> };
      this.cache = data.flags;
      const elapsed = nowMs() - startedAt;
      const flagKeys = Object.keys(data.flags);
      const perFlagLatency = flagKeys.length > 0 ? elapsed / flagKeys.length : 0;
      const ts = Math.floor(Date.now() / 1000);
      for (const result of Object.values(data.flags)) {
        this.recordEvaluation({
          flagKey: result.flagKey,
          variationKey: variationKeyFromValue(result.value),
          reason: result.reason,
          latencyMs: perFlagLatency,
          timestamp: ts,
        });
      }
      return data.flags;
    } catch {
      return {};
    }
  }

  /**
   * Subscribe to real-time flag updates via SSE (Pro plan+).
   *
   * The server emits a `flags.updated` event whenever any flag in the env
   * changes. The SDK reacts by re-running `evaluateAll(context)` to refresh
   * the local cache, then invokes `onChange` with the new flag map.
   *
   * Falls back to polling `evaluateAll` on EventSource failure or when
   * `EventSource` is unavailable (e.g. server-side runtimes).
   *
   * Returns an `unsubscribe` function — call it to close the connection.
   */
  stream(
    context: UserContext,
    onChange: FlagsUpdateCallback,
    options: { pollingIntervalMs?: number } = {},
  ): () => void {
    // EventSource doesn't support custom headers — pass apiKey as query param
    const url = `${this.apiUrl}/v1/stream?apiKey=${encodeURIComponent(this.apiKey)}`;
    const pollingMs = options.pollingIntervalMs ?? 30_000;

    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const refresh = async () => {
      if (closed) return;
      const flags = await this.evaluateAll(context);
      if (!closed) onChange(flags);
    };

    const startPolling = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(refresh, pollingMs);
    };

    const tryStream = () => {
      if (typeof EventSource === 'undefined') {
        // Prime the cache, then poll on an interval
        void refresh();
        startPolling();
        return;
      }

      es = new EventSource(url);

      // Prime the cache as soon as the connection is open so subscribers
      // have flag state at t=0 without waiting for the first mutation.
      es.addEventListener('connected', () => {
        void refresh();
      });

      es.addEventListener('flags.updated', () => {
        void refresh();
      });

      es.onerror = () => {
        es?.close();
        es = null;
        // Fall back to polling on SSE error (e.g. free plan 402)
        void refresh();
        startPolling();
      };
    };

    tryStream();

    return () => {
      closed = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }

  // ─── Analytics ──────────────────────────────────────────────────────────────

  /**
   * Force-flush the analytics buffer. Returns the number of events submitted
   * (0 when the buffer was already empty or analytics are disabled).
   *
   * Tests should call this and `await` the result instead of relying on the
   * timer. Production callers may invoke it on `beforeunload` to ensure the
   * final batch is sent before the page unloads.
   */
  async flushAnalytics(): Promise<number> {
    if (!this.analyticsConfig.enabled) return 0;
    if (this.analyticsBuffer.length === 0) return 0;
    const events = this.analyticsBuffer;
    this.analyticsBuffer = [];

    try {
      const res = await this.fetch(`${this.apiUrl}/v1/analytics/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        // Re-buffer on transient/retryable failures so the next flush retries —
        // server errors (>=500) and throttling (429). A 429 is explicitly
        // retryable: dropping it silently loses metrics and leaves the
        // dashboard empty. Hard 4xx (400/401/403 — malformed batch or bad
        // credentials) are NOT retried, since replaying them can't succeed and
        // would grow the buffer unbounded. Re-buffering is capped so a
        // permanently-failing server can't cause unbounded growth.
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && this.analyticsBuffer.length + events.length <= this.analyticsConfig.maxBufferSize) {
          this.analyticsBuffer = [...events, ...this.analyticsBuffer];
        }
        return 0;
      }
      return events.length;
    } catch {
      // Network error — re-buffer with the same cap as above.
      if (this.analyticsBuffer.length + events.length <= this.analyticsConfig.maxBufferSize) {
        this.analyticsBuffer = [...events, ...this.analyticsBuffer];
      }
      return 0;
    }
  }

  /** Stop the periodic analytics flush. Use before discarding the client. */
  close(): void {
    if (this.analyticsTimer) {
      clearInterval(this.analyticsTimer);
      this.analyticsTimer = null;
    }
    // Best-effort final flush — fire and forget.
    void this.flushAnalytics();
  }

  /** @internal */
  recordEvaluation(event: PendingAnalyticsEvent): void {
    if (!this.analyticsConfig.enabled) return;
    if (this.analyticsConfig.samplingRate < 1 && Math.random() >= this.analyticsConfig.samplingRate) {
      return;
    }
    if (this.analyticsBuffer.length >= this.analyticsConfig.maxBufferSize) {
      // Drop oldest to keep memory bounded — recent samples are more useful.
      this.analyticsBuffer.shift();
    }
    this.analyticsBuffer.push(event);
    if (this.analyticsBuffer.length >= this.analyticsConfig.maxBatchSize) {
      void this.flushAnalytics();
    }
  }

  /** @internal — exposed for tests; reset mid-flight. */
  _bufferSize(): number {
    return this.analyticsBuffer.length;
  }

  private startAnalyticsTimer(): void {
    if (typeof setInterval === 'undefined') return;
    this.analyticsTimer = setInterval(() => {
      void this.flushAnalytics();
    }, this.analyticsConfig.flushIntervalMs);
    // In Node-like environments, setInterval keeps the event loop alive. Use
    // unref() if available so a hanging timer doesn't block process exit.
    const t = this.analyticsTimer as { unref?: () => void } | null;
    if (t && typeof t.unref === 'function') t.unref();
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Create a ShipSilently client instance.
 *
 * @example
 * ```ts
 * import ShipSilently from 'shipsilently-js';
 *
 * const client = ShipSilently.init({ apiKey: 'sk_live_...' });
 * const enabled = await client.evaluate('new-checkout', { userId: 'u_123' }, false);
 * ```
 */
const ShipSilently = {
  init(config: ShipSilentlyConfig): ShipSilentlyClient {
    return new ShipSilentlyClient(config);
  },
};

export default ShipSilently;
export { ShipSilently };
