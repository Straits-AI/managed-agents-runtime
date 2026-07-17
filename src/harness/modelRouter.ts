import type { Config } from '../config.js';
import type { AgentVersionRow } from '../store/agents.js';

/**
 * Adaptive model routing (memo §25). The base model comes from the agent
 * version's policy (or the ARK_MODEL default). When the semantic supervisor
 * escalates a stuck run, route to a stronger model — the version's
 * `escalationModel` if set, else the ESCALATION_MODEL config default, else stay
 * on the base model. Every model call names its own model (ModelProvider.chat),
 * so this is a pure string choice with no provider change.
 */
export function routeModel(
  policy: AgentVersionRow['model_policy'],
  cfg: Config,
  escalationLevel: number,
): string {
  const base = policy.model ?? cfg.ARK_MODEL ?? '';
  if (escalationLevel <= 0) return base;
  return policy.escalationModel ?? cfg.ESCALATION_MODEL ?? base;
}
