/**
 * Bounded ModelArk smoke test: one chat call, ≤32 output tokens.
 * Prints only model identity, finish metadata, and usage — never content.
 *
 *   node --env-file=.env --import tsx scripts/smoke-ark.ts
 */
import { loadConfig, requireConfig } from '../src/config.js';
import { ModelArkProvider } from '../src/providers/modelark.js';

const cfg = loadConfig();
const { ARK_MODEL } = requireConfig(cfg, ['ARK_API_KEY', 'ARK_MODEL']);

const provider = new ModelArkProvider(cfg);
const started = Date.now();
const res = await provider.chat({
  model: ARK_MODEL,
  messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  maxTokens: 32,
});

const gotMarker = /pong/i.test(res.message.content ?? '');
console.log(`model: ${ARK_MODEL}`);
console.log(`marker received: ${gotMarker}`);
console.log(
  `usage: in=${res.usage.inputTokens} out=${res.usage.outputTokens} latency=${Date.now() - started}ms`,
);
if (!gotMarker) {
  console.error('smoke test FAILED: expected marker not in response');
  process.exit(1);
}
console.log('ModelArk smoke test PASSED');
