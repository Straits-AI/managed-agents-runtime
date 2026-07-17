import type { ResolvedSkill, SkillProvider, SkillRef } from './types.js';

/**
 * In-process Skill registry (the default SkillProvider): skills are registered
 * by `${skill}@${version}` and resolved with strict version pinning — resolving
 * an unregistered or unpinned ref throws, so a resumed run can never silently
 * pick up a different skill version. Swap for AgentKitSkillProvider (Skills
 * Spaces) without touching the kernel.
 */
export class RegistrySkillProvider implements SkillProvider {
  private readonly skills = new Map<string, ResolvedSkill>();

  register(version: string, skill: ResolvedSkill): this {
    this.skills.set(`${skill.name}@${version}`, { ...skill, version });
    return this;
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill> {
    if (!ref.version || ref.version === 'latest') {
      throw new Error(`skill ${ref.skill} must be pinned to an exact version (got '${ref.version}')`);
    }
    const found = this.skills.get(`${ref.skill}@${ref.version}`);
    if (!found) {
      throw new Error(`skill not found in registry: ${ref.skill}@${ref.version}`);
    }
    return found;
  }
}
