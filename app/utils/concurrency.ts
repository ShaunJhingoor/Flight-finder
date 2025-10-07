export async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>
): Promise<R | null> {
  return new Promise((resolve) => {
    let i = 0,
      active = 0,
      done = false;

    const next = () => {
      if (done) return;
      if (i >= items.length && active === 0) return resolve(null);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        worker(items[idx])
          .then((res) => {
            active--;
            if (!done && res) {
              done = true;
              resolve(res);
            } else {
              next();
            }
          })
          .catch(() => {
            active--;
            next();
          });
      }
    };

    next();
  });
}
// utils/withTimeout.ts
export class TimeoutError extends Error {
  constructor(public ms: number, msg = "Request timed out") {
    super(msg);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  ms = 10000 // was 3500–5000
): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new TimeoutError(ms, `Upstream call exceeded ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function withRetry<T>(
  op: (signal?: AbortSignal) => Promise<T>,
  {
    attempts = 2,
    timeoutMs = 10000,
    backoffMs = 500,
  }: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {}
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(op, timeoutMs);
    } catch (e: any) {
      lastErr = e;
      const transient =
        e?.name === "AbortError" ||
        e instanceof TimeoutError ||
        (typeof e?.message === "string" &&
          /ECONNRESET|ETIMEDOUT|EAI_AGAIN|503|504/.test(e.message));
      if (!transient || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}
