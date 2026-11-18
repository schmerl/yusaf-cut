import { audioPeaks } from "./ipc";

// Share in-flight work across remounts; retain only a few sources in memory.
const cache = new Map<string, Promise<number[]>>();
export function loadPeaks(key: string, path: string) {
  let pending = cache.get(key);
  if (!pending) {
    pending = audioPeaks(path).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return pending;
}
