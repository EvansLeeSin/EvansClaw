import { basename, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillFrontmatter } from "./skill-types.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_MAX_SKILL_BYTES = 256 * 1024;

export interface ParsedSkillDocument {
  frontmatter: SkillFrontmatter;
  body: string;
}

export class SkillValidationError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "SkillValidationError";
  }
}

/**
 * Parse and validate an Agent Skills `SKILL.md` document.
 *
 * The parser intentionally validates the stable interchange fields instead of
 * accepting arbitrary values as permissions. Product-specific fields are
 * retained in `extra`, while tool authorization remains a future Policy
 * concern.
 */
export function parseSkillDocument(
  text: string,
  filePath: string,
  options: { maxBytes?: number } = {},
): ParsedSkillDocument {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new SkillValidationError(
      `文件超过 ${maxBytes} 字节限制。`,
      filePath,
    );
  }

  const normalizedText = text.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_PATTERN.exec(normalizedText);
  if (!match) {
    throw new SkillValidationError(
      "必须以 YAML frontmatter（---）开头，并包含结束分隔线。",
      filePath,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillValidationError(`YAML frontmatter 无效：${message}`, filePath);
  }

  const raw = asRecord(parsed, filePath, "frontmatter 必须是对象");
  const directoryName = basename(dirname(filePath));
  const name = requiredString(raw.name, "name", filePath);
  if (name.length > 64) {
    throw new SkillValidationError("name 不能超过 64 个字符。", filePath);
  }
  if (!SKILL_NAME_PATTERN.test(name) || name.includes("--")) {
    throw new SkillValidationError(
      "name 只能包含小写字母、数字和单个连字符，且不能以连字符开头或结尾。",
      filePath,
    );
  }
  if (name !== directoryName) {
    throw new SkillValidationError(
      `name 必须与父目录名称一致（父目录为 ${directoryName}）。`,
      filePath,
    );
  }

  const description = requiredString(raw.description, "description", filePath);
  if (description.length > 1024) {
    throw new SkillValidationError("description 不能超过 1024 个字符。", filePath);
  }

  const license = optionalString(raw.license, "license", filePath);
  const compatibility = optionalString(
    raw.compatibility,
    "compatibility",
    filePath,
  );
  if (compatibility && compatibility.length > 500) {
    throw new SkillValidationError(
      "compatibility 不能超过 500 个字符。",
      filePath,
    );
  }

  const allowedTools = optionalString(
    raw["allowed-tools"],
    "allowed-tools",
    filePath,
  );
  const version = optionalString(raw.version, "version", filePath);
  const userInvocable = optionalBoolean(
    raw["user-invocable"],
    "user-invocable",
    filePath,
  );
  const disableModelInvocation = optionalBoolean(
    raw["disable-model-invocation"],
    "disable-model-invocation",
    filePath,
  );
  const metadata = optionalStringMap(raw.metadata, "metadata", filePath);

  const knownKeys = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "allowed-tools",
    "version",
    "user-invocable",
    "disable-model-invocation",
    "metadata",
  ]);
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !knownKeys.has(key)),
  );

  return {
    frontmatter: {
      name,
      description,
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(version === undefined ? {} : { version }),
      ...(userInvocable === undefined ? {} : { userInvocable }),
      ...(disableModelInvocation === undefined
        ? {}
        : { disableModelInvocation }),
      metadata,
      extra,
    },
    body: normalizedText.slice(match[0].length).trim(),
  };
}

function asRecord(
  value: unknown,
  filePath: string,
  message: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillValidationError(message, filePath);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  filePath: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillValidationError(`${field} 必须是非空字符串。`, filePath);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  filePath: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SkillValidationError(`${field} 必须是字符串。`, filePath);
  }
  return value.trim();
}

function optionalBoolean(
  value: unknown,
  field: string,
  filePath: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new SkillValidationError(`${field} 必须是布尔值。`, filePath);
  }
  return value;
}

function optionalStringMap(
  value: unknown,
  field: string,
  filePath: string,
): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = asRecord(value, filePath, `${field} 必须是对象。`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new SkillValidationError(
        `${field}.${key} 必须是字符串。`,
        filePath,
      );
    }
    result[key] = item;
  }
  return result;
}
