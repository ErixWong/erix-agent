export function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason === undefined
    ? "The operation was aborted"
    : String(signal.reason));
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw abortError(signal);
}

export function defaultSleep(ms, signal) {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
