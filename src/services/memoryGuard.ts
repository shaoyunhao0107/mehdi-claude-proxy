// Local patch: keep the processes started in advance (warm sessions, prewarmed spares)
// from pushing the server into swap. Each is a full CLI (~250 MB); on a small server a
// few warm sessions plus parallel subagents can use up the RAM, and then every request
// slows down. Requests themselves are never refused here: only work started early is
// skipped (or closed) while free memory is low, and those requests just start cold.
import { freemem, totalmem } from "os";

const MIN_FREE_MB = Math.max(0, parseInt(process.env.MIN_FREE_MEMORY_MB || "1024", 10));
const PER_PROCESS_MB = 250;

let skipped = 0;
let lastWarn = 0;

export function freeMb(): number {
  return Math.round(freemem() / 1048576);
}

/** True when one more early CLI would leave less than MIN_FREE_MEMORY_MB free. */
export function tooLowForEarlyStart(what: string): boolean {
  if (MIN_FREE_MB === 0) return false;
  const free = freeMb();
  if (free - PER_PROCESS_MB >= MIN_FREE_MB) return false;
  skipped++;
  if (Date.now() - lastWarn > 60_000) {
    lastWarn = Date.now();
    console.warn(`[memory] ${free} MB free (minimum ${MIN_FREE_MB} MB): not starting ${what} early`);
  }
  return true;
}

export function memoryStatus() {
  return { freeMb: freeMb(), totalMb: Math.round(totalmem() / 1048576), minFreeMb: MIN_FREE_MB, earlyStartsSkipped: skipped };
}
