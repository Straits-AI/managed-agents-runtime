/**
 * Entry point: run a single scenario by id.
 *   node --env-file=.env --import tsx scenarios/run.ts <scenario-id>
 */
import { SCENARIOS } from './cases.js';
import { runScenario } from './runner.js';

const id = process.argv[2];
if (!id || !SCENARIOS[id]) {
  console.error(`usage: run.ts <scenario-id>\navailable: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}
await runScenario(SCENARIOS[id]);
