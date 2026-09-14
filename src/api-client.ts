/**
 * GET + JSON with a per-attempt timeout and exponential backoff on transient
 * failures. The hospital snapshot endpoint is the only thing this is used for,
 * and it needs minutes, not seconds — hence the configurable timeout.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export type FetchOptions = {
  /** Total attempts including the first. */
  attempts?: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
};

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { attempts = 3, timeoutMs = 10_000 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

      if (!response.ok) {
        const error = new HttpError(response.status, await response.text());
        // A 4xx that isn't rate limiting will never succeed — fail fast.
        if (!RETRYABLE.has(response.status)) throw error;
        lastError = error;
      } else {
        return (await response.json()) as T;
      }
    } catch (error) {
      if (error instanceof HttpError && !RETRYABLE.has(error.status)) throw error;
      lastError = error;
    }

    if (attempt < attempts) {
      const backoffMs = 2 ** attempt * 250;
      console.error(`  retry ${attempt}/${attempts - 1} in ${backoffMs}ms — ${String(lastError)}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}
