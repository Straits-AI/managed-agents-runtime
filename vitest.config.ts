import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suite: worker subprocesses + CPU contention add latency, so
    // give correct tests headroom. Real failures still surface instantly via
    // assertions; observed full-suite runs are ~15-20s.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // The scheduler/worker integration tests spawn real worker *subprocesses*
    // (one Node process per worker) on top of vitest's own file-level workers.
    // Left unbounded, many file-workers + their spawned workers oversubscribe an
    // 8-core machine, starving the timing-sensitive lease/heartbeat/poll loops.
    // Cap concurrent file-workers so spawned workers still get CPU. (Vitest 4
    // promoted this from the removed test.poolOptions.forks.maxForks.)
    maxWorkers: 4,
  },
});
