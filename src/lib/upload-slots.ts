import { MAX_CONCURRENT_UPLOADS, MAX_QUEUED_UPLOADS } from "@/lib/upload-limits";

/**
 * Only so many models are held in memory at once.
 *
 * This is what makes a 250 MB cap safe rather than hopeful. An upload's body is
 * buffered by `request.formData()` before a line of the handler runs, and an
 * import buffers the file it fetches, so peak memory is decided by how many
 * large models overlap — nothing the validator does can change that. Bounding
 * the overlap bounds the memory, which is the "size-based queue" the security
 * audit named as one of the two answers. (The other, a streaming parse, needs
 * the file to stop arriving as multipart at all; see docs/architecture.md.)
 *
 * A late arrival waits rather than being refused: somebody who has just spent a
 * minute pushing 200 MB up office wifi should not be told to start again. Only
 * once the queue itself is long does the app say no, because at that point the
 * honest answer is that it is busy.
 *
 * One gate for both doors. It lived inside the upload route while that was the
 * only way a model arrived; an import is the same memory by a different road,
 * and two gates of two would have been a gate of four.
 *
 * Per process, and held on `globalThis` rather than in module scope: the two
 * routes are bundled separately and are not promised the same instance of this
 * module, and a gate each would again be no gate. A second app *process* has
 * its own, which is the right shape anyway — the memory it is protecting is
 * also per process.
 */
type Gate = { active: number; waiting: Array<() => void> };

const KEY = Symbol.for("ppp.upload-slots");
const holder = globalThis as unknown as Record<symbol, Gate | undefined>;
const gate: Gate = (holder[KEY] ??= { active: 0, waiting: [] });

/** A slot, or `false` when the queue for one is already long. */
export function acquireSlot(): Promise<boolean> {
  if (gate.active < MAX_CONCURRENT_UPLOADS) {
    gate.active++;
    return Promise.resolve(true);
  }
  if (gate.waiting.length >= MAX_QUEUED_UPLOADS) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    gate.waiting.push(() => {
      gate.active++;
      resolve(true);
    });
  });
}

export function releaseSlot(): void {
  gate.active--;
  gate.waiting.shift()?.();
}

export const BUSY_COPY = "Too many uploads at once — give it a moment and send it again.";
