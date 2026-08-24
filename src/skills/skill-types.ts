export type SkillSource = "bundled" | "project" | "project-agent" | "user";

export interface SkillRoot {
  /** Directory containing one or more skill directories. */
  path: string;
  source: SkillSource;
  /** Higher values override lower values when names collide. */
  priority?: number;
}

/**
 * The supported Agent Skills frontmatter fields.
 *
 * `metadata` and `extra` deliberately remain separate: metadata follows the
 * Agent Skills string-to-string convention, while extra fields preserve
 * product-specific extensions without making them security decisions.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  version?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface SkillSummary extends SkillFrontmatter {
  source: SkillSource;
  priority: number;
  directoryPath: string;
  filePath: string;
  lastModifiedAt: number;
}

export interface LoadedSkill {
  summary: SkillSummary;
  /** Markdown body without YAML frontmatter. */
  body: string;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

export interface SkillLoadDetails {
  name: string;
  source: SkillSource;
  /** Number of UTF-16 code units returned to the model. */
  bodyLength: number;
}
