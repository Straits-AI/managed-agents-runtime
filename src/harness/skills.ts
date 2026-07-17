import type { SandboxHandle, SandboxProvider, SkillProvider, SkillRef } from '../providers/types.js';
import { WORKSPACE_DIR } from './workspace.js';

const SKILLS_DIR = `${WORKSPACE_DIR}/.skills`;

export interface MaterializedSkill {
  name: string;
  version: string;
  description?: string;
  path: string;
}

/**
 * Resolve version-pinned skill refs and materialize their files into the
 * sandbox workspace under .skills/<name>/ (memo §9.1). Returns a summary the
 * context compiler surfaces so the agent knows which skills are available and
 * where. A failed skill resolution aborts the epoch — a run must run with
 * exactly the skills it pinned, or not at all.
 */
export async function materializeSkills(
  sandbox: SandboxHandle,
  sandboxProvider: SandboxProvider,
  skillProvider: SkillProvider | undefined,
  refs: SkillRef[],
): Promise<MaterializedSkill[]> {
  if (!skillProvider || refs.length === 0) return [];

  const out: MaterializedSkill[] = [];
  for (const ref of refs) {
    const skill = await skillProvider.resolve(ref);
    const base = `${SKILLS_DIR}/${skill.name}`;
    for (const [rel, content] of Object.entries(skill.files)) {
      await sandboxProvider.writeFile(sandbox, `${base}/${rel}`, content);
    }
    out.push({ name: skill.name, version: skill.version, description: skill.description, path: base });
  }
  return out;
}
