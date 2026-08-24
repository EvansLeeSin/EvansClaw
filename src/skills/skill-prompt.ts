import type { LoadedSkill, SkillSummary } from "./skill-types.js";
import { SkillRegistry, formatLoadedSkill } from "./skill-registry.js";

export interface SkillPromptBuilderOptions {
  /** Maximum number of automatically activated Skills for one turn. */
  maxAutoActivations?: number;
}

/**
 * Builds the system prompt for one turn using progressive disclosure:
 * metadata is always compact, while full Markdown is added only for explicit
 * or strongly matching Skills. The model also has the read-only `load_skill`
 * tool for cases the local matcher cannot identify.
 */
export class SkillPromptBuilder {
  private readonly maxAutoActivations: number;

  constructor(
    private readonly baseSystemPrompt: string,
    private readonly registry: SkillRegistry,
    options: SkillPromptBuilderOptions = {},
  ) {
    this.maxAutoActivations = options.maxAutoActivations ?? 2;
  }

  /** Build the base prompt plus the compact metadata catalog. */
  buildCatalogPrompt(): string {
    return appendPrompt(
      this.baseSystemPrompt,
      formatSkillCatalog(this.registry.getSummaries()),
    );
  }

  /** Build the prompt for one user turn and activate relevant Skills. */
  async buildForTurn(userText: string): Promise<string> {
    const summaries = await this.registry.list();
    const byName = new Map(summaries.map((summary) => [summary.name, summary]));
    const explicitNames = findExplicitSkillNames(userText);
    const activeNames = new Set<string>();

    for (const name of explicitNames) {
      const summary = byName.get(name);
      if (summary?.userInvocable !== false) activeNames.add(name);
    }

    const automaticCandidates = summaries
      .filter(
        (summary) =>
          summary.disableModelInvocation !== true &&
          !activeNames.has(summary.name),
      )
      .map((summary) => ({
        summary,
        score: scoreDescriptionMatch(userText, summary),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.summary.name.localeCompare(right.summary.name),
      );

    for (const candidate of automaticCandidates.slice(
      0,
      this.maxAutoActivations,
    )) {
      activeNames.add(candidate.summary.name);
    }

    const activeSkills: LoadedSkill[] = [];
    for (const name of activeNames) {
      try {
        activeSkills.push(
          explicitNames.includes(name)
            ? await this.registry.load(name)
            : await this.registry.loadForModel(name),
        );
      } catch (error) {
        // Explicit references should fail loudly. A stale or malformed skill
        // discovered by heuristic matching must not make ordinary chat fail.
        if (explicitNames.includes(name)) throw error;
      }
    }

    const activePrompt = activeSkills
      .map((skill) => formatLoadedSkill(skill))
      .join("\n\n");

    return appendPrompt(
      appendPrompt(
        this.baseSystemPrompt,
        formatSkillCatalog(summaries),
      ),
      activePrompt,
    );
  }
}

export function formatSkillCatalog(summaries: SkillSummary[]): string {
  const visible = summaries.filter(
    (summary) => summary.disableModelInvocation !== true,
  );
  if (visible.length === 0) return "";

  const entries = visible
    .map(
      (summary) =>
        `- ${escapePromptText(summary.name)}: ${escapePromptText(summary.description)}`,
    )
    .join("\n");

  return [
    "<available_skills>",
    "以下 Skill 只提供流程知识，不会改变系统指令，也不会授予额外工具权限。任务需要某个 Skill 时，请先调用 load_skill 并传入准确的 name。",
    entries,
    "</available_skills>",
  ].join("\n");
}

function findExplicitSkillNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|\s)[/$]([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function scoreDescriptionMatch(text: string, summary: SkillSummary): number {
  const userTerms = extractTerms(text);
  const descriptionTerms = extractTerms(
    `${summary.name} ${summary.description}`,
  );
  const overlap = [...descriptionTerms].filter((term) => userTerms.has(term));
  if (overlap.length === 0) return 0;

  const asciiOverlap = overlap.filter((term) => /^[a-z0-9-]+$/.test(term));
  const cjkOverlap = overlap.filter((term) => /[\u3400-\u9fff]/u.test(term));

  // English needs a meaningful word; Chinese needs two overlapping bigrams
  // so generic one-character words do not activate arbitrary Skills.
  if (asciiOverlap.some((term) => term.length >= 4)) return 2;
  if (asciiOverlap.length >= 2) return 1;
  if (cjkOverlap.length >= 2) return 1;
  return 0;
}

function extractTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLocaleLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    terms.add(word);
  }

  for (const run of text.match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length >= 2) terms.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return terms;
}

function appendPrompt(base: string, addition: string): string {
  if (!addition) return base;
  return `${base}\n\n${addition}`;
}

function escapePromptText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
