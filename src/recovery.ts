/** Bound latency even when a provider does not honor AbortSignal. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs must be positive");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const cancel = () => {
    controller.abort();
    rejectAbort?.(new Error("Decision aborted"));
  };
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Decision timed out"));
        }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("Decision aborted");
        return operation(controller.signal);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
