import { stopping } from './stop.js';

// Deliberately not unref'd: during a pause this is often the only thing pending,
// and an unref'd timer would let the process exit cleanly in the middle of a run.
// Polled so a shutdown signal does not have to wait out the whole pause.
async function pause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopping()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
  }
}

export async function pool(items, limit, worker, { pauseMs = 0, pauseWhen = () => true, onPause } = {}) {
  const size = Math.max(1, Math.min(limit, items.length));
  if (pauseMs <= 0) return continuousPool(items, size, worker);

  const results = [];
  for (let i = 0; i < items.length; i += size) {
    if (stopping()) break;
    const batch = items.slice(i, i + size);
    const done = await Promise.all(batch.map((item, j) => worker(item, i + j)));
    const settled = done.filter((r) => r !== undefined);
    results.push(...settled);

    if (i + size >= items.length || stopping()) continue;
    // The pause exists to go easy on the servers, so a batch that transferred
    // nothing has nothing to recover from.
    if (!pauseWhen(settled)) continue;
    onPause?.(settled);
    await pause(pauseMs);
  }
  return results;
}

async function continuousPool(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        if (stopping()) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results.filter((r) => r !== undefined);
}
