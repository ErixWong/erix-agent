import { KitError } from "./errors.js";

function defaultNow() {
  return Date.now();
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "The operation was aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

function normalizeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Coordinate request and stream phase deadlines with one AbortController.
 *
 * The legacy deadline is intentionally one absolute deadline. This preserves
 * the old timeoutMs behavior while explicit phase settings use independent
 * first-byte and idle timers plus an absolute stream-total deadline.
 */
export function createProviderTimeoutContext({
  timeouts,
  externalSignal,
  clock,
} = {}) {
  const now = typeof clock === "function"
    ? clock
    : typeof clock?.now === "function"
      ? clock.now.bind(clock)
      : defaultNow;
  const setTimer = typeof clock?.setTimeout === "function"
    ? clock.setTimeout.bind(clock)
    : setTimeout;
  const clearTimer = typeof clock?.clearTimeout === "function"
    ? clock.clearTimeout.bind(clock)
    : clearTimeout;
  const controller = new AbortController();
  const startedAt = now();
  const legacyTimeoutMs = normalizeDuration(timeouts?.legacyTimeoutMs);
  const legacyDeadline = legacyTimeoutMs === undefined
    ? undefined
    : startedAt + legacyTimeoutMs;
  let streamStartedAt;
  let timeoutFailure;
  let externalFailure;
  let removeExternalListener;

  let rejectExternal;
  const externalPromise = new Promise((_, reject) => {
    rejectExternal = reject;
  });
  externalPromise.catch(() => {});

  const onExternalAbort = () => {
    externalFailure = abortError(externalSignal?.reason);
    controller.abort(externalFailure);
    rejectExternal(externalFailure);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else if (typeof externalSignal.addEventListener === "function") {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      if (typeof externalSignal.removeEventListener === "function") {
        removeExternalListener = () => externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  const elapsedMs = () => Math.max(0, now() - startedAt);

  const timeoutError = (phase) => new KitError("timeout", `${phase} timed out`, {
    retryable: true,
    phase,
    elapsedMs: elapsedMs(),
  });

  const throwIfAborted = () => {
    if (externalFailure) throw externalFailure;
    if (externalSignal?.aborted) {
      onExternalAbort();
      throw externalFailure;
    }
  };

  const phaseEntries = (entries) => {
    const normalized = entries
      .map((entry) => ({
        phase: entry.phase,
        duration: normalizeDuration(entry.duration),
      }))
      .filter((entry) => entry.duration !== undefined);

    if (legacyDeadline !== undefined) {
      const remaining = Math.max(0, legacyDeadline - now());
      return [{ phase: "request", duration: remaining }];
    }
    return normalized;
  };

  const race = async (promise, entries = []) => {
    throwIfAborted();
    const timers = [];
    const timeoutPromises = phaseEntries(entries).map(({ phase, duration }) => (
      new Promise((_, reject) => {
        const timer = setTimer(() => {
          timeoutFailure = timeoutError(phase);
          controller.abort(timeoutFailure);
          reject(timeoutFailure);
        }, duration);
        timers.push(timer);
      })
    ));

    try {
      const candidates = [Promise.resolve(promise), ...timeoutPromises];
      if (externalSignal) candidates.push(externalPromise);
      return await Promise.race(candidates);
    } finally {
      for (const timer of timers) clearTimer(timer);
    }
  };

  const beginStream = () => {
    streamStartedAt = now();
  };

  const streamElapsedMs = () => (
    streamStartedAt === undefined ? 0 : Math.max(0, now() - streamStartedAt)
  );

  const dispose = () => {
    removeExternalListener?.();
  };

  return {
    controller,
    race,
    beginStream,
    streamElapsedMs,
    elapsedMs,
    throwIfAborted,
    didTimeout: () => timeoutFailure !== undefined,
    timeoutError: () => timeoutFailure,
    didExternalAbort: () => externalFailure !== undefined,
    externalError: () => externalFailure,
    dispose,
    timeouts,
  };
}
