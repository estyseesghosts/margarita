import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import { type GoalPlanV1, parseGoalPlan } from '../domain/goal-plan.ts';

/** Another process saved a newer revision since this one was loaded. */
export class GoalConflictError extends Error {
  constructor(readonly current: GoalPlanV1) {
    super('goal plan changed elsewhere');
  }
}

export type GoalStore = Readonly<{
  load(sessionID: string): Promise<GoalPlanV1 | undefined>;
  /**
   * Compare-and-swap save: succeeds only when the stored revision still equals
   * `doc.revision`. Returns the saved document with its revision bumped.
   */
  save(doc: GoalPlanV1): Promise<GoalPlanV1>;
}>;

function fileName(sessionID: string): string {
  return `${sessionID.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

/** Sidecar files under margarita's own state directory; never inside the user's repository. */
export function fileGoalStore(dir: string, now: () => string): GoalStore {
  const pathOf = (sessionID: string) => join(dir, fileName(sessionID));
  const read = async (sessionID: string): Promise<GoalPlanV1 | undefined> => {
    let source: string;
    try {
      source = await readFile(pathOf(sessionID), 'utf8');
    } catch (cause) {
      if (isRecord(cause) && cause['code'] === 'ENOENT') return undefined;
      throw cause;
    }
    return parseGoalPlan(JSON.parse(source), now());
  };
  return {
    load: read,
    async save(doc) {
      const path = pathOf(doc.sessionID);
      const lock = `${path}.lock`;
      await mkdir(dirname(path), { recursive: true });
      // An exclusive lock file makes read-compare-rename atomic across processes.
      await acquire(lock);
      try {
        const current = await read(doc.sessionID);
        if ((current?.revision ?? 0) !== doc.revision) {
          throw new GoalConflictError(current ?? doc);
        }
        const saved: GoalPlanV1 = { ...doc, revision: doc.revision + 1 };
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temp, path);
        return saved;
      } finally {
        await unlink(lock).catch(() => {});
      }
    },
  };
}

const lockAttempts = 50;
const staleLockMs = 10_000;

async function acquire(lock: string): Promise<void> {
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    try {
      await writeFile(lock, String(Date.now()), { flag: 'wx' });
      return;
    } catch (cause) {
      if (!isRecord(cause) || cause['code'] !== 'EEXIST') throw cause;
      const since = Number(await readFile(lock, 'utf8').catch(() => '0'));
      if (Date.now() - since > staleLockMs) await unlink(lock).catch(() => {});
      else await Bun.sleep(10);
    }
  }
  throw new Error('goal plan is locked by another process');
}

/** In-memory store for tests and for sessions whose sidecar cannot be written. */
export function memoryGoalStore(): GoalStore & { docs: Map<string, GoalPlanV1> } {
  const docs = new Map<string, GoalPlanV1>();
  return {
    docs,
    async load(sessionID) {
      return docs.get(sessionID);
    },
    async save(doc) {
      const current = docs.get(doc.sessionID);
      if ((current?.revision ?? 0) !== doc.revision) throw new GoalConflictError(current ?? doc);
      const saved = { ...doc, revision: doc.revision + 1 };
      docs.set(doc.sessionID, saved);
      return saved;
    },
  };
}
