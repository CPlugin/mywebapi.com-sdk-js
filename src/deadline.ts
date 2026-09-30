// Runtime-independent operation deadlines.
//
// Platform-provided timeout signals may cancel their timer when the last listener is
// removed before the deadline (Bun 1.3.14). Keep the timer owned by this operation
// so shared-token listener cleanup cannot disable the HTTP deadline.

export async function withDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let completed = false;
  const timer = setTimeout(() => {
    if (!completed) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);
  // Keep caller-owned signals untouched; removing their last listener may cancel
  // a runtime-managed timeout. The private composite receives operation listeners.
  const operationSignal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;

  try {
    return await operation(operationSignal);
  } finally {
    completed = true;
    clearTimeout(timer);
  }
}
