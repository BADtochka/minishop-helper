export type ProgressReporter = (status: string) => void | Promise<void>;

export async function reportProgress(reporter: ProgressReporter | undefined, status: string): Promise<void> {
  await reporter?.(status.slice(0, 4096));
}

export function throttledProgress(reporter: ProgressReporter, intervalMs = 750, now: () => number = Date.now): ProgressReporter {
  let lastAt = -Infinity;
  let lastStatus = "";
  return async (status) => {
    const timestamp = now();
    if (status === lastStatus || timestamp - lastAt < intervalMs) return;
    lastAt = timestamp;
    lastStatus = status;
    await reporter(status.slice(0, 4096));
  };
}
