const MAX_SEARCH_QUERY_LENGTH = 2_048;
const MAX_SEARCH_LIMIT = 100;

export interface SessionSearchOptions {
  sessionId?: string;
  conversationId?: string;
  channel?: string;
  userId?: string;
  role?: string;
  limit?: number;
  offset?: number;
}

export interface SessionSearchResult {
  messageId: number;
  sessionId: string;
  conversationId: string;
  channel: string;
  userId: string;
  role: string;
  sequence: number;
  content: string | null;
  snippet: string;
  createdAt: number;
}

export type SearchRoute = "fts" | "trigram" | "like";

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function containsCjk(text: string): boolean {
  return [...text].some((character) => isCjkCodePoint(character.codePointAt(0) ?? 0));
}

function tokenizeQuery(query: string): string[] {
  return query.match(/"[^"]*"|\S+/g) ?? [];
}

function removeWrappingQuotes(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).trim();
  }
  return token.trim();
}

function countCjkCharacters(text: string): number {
  return [...text].filter((character) =>
    isCjkCodePoint(character.codePointAt(0) ?? 0),
  ).length;
}

/** 在拼接 SQL 之前，规范化并限制用户输入的搜索关键词长度。 */
export function normalizeSearchQuery(query: string): string {
  const normalized = query.trim();
  if (normalized.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`搜索关键词不能超过 ${MAX_SEARCH_QUERY_LENGTH} 个字符。`);
  }
  return normalized;
}

/**
 * 把普通用户输入处理成隐式 AND 查询，并为每个词加引号。
 * 这样可以避免 FTS5 运算符和标点意外改变搜索语法。
 */
export function toFtsQuery(query: string): string {
  return tokenizeQuery(query)
    .map(removeWrappingQuotes)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

export function toLikeTerms(query: string): string[] {
  return tokenizeQuery(query).map(removeWrappingQuotes).filter(Boolean);
}

/**
 * 内置 trigram 分词器无法匹配只有两个字符的中日韩文字词语。
 * 这类查询使用 LIKE；只有每个中日韩文字词语至少包含三个字符时才使用
 * trigram，从而让混合语言查询的路由行为保持确定。
 */
export function chooseSearchRoute(query: string): SearchRoute {
  const tokens = tokenizeQuery(query).map(removeWrappingQuotes).filter(Boolean);
  const cjkTokens = tokens.filter(containsCjk);
  if (cjkTokens.length === 0) return "fts";

  return cjkTokens.every((token) => countCjkCharacters(token) >= 3)
    ? "trigram"
    : "like";
}

export function escapeLikeTerm(term: string): string {
  return term
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

export function clampSearchOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}
