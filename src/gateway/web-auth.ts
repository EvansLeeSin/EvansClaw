import { timingSafeEqual } from "node:crypto";
import type { AgentSessionProfile } from "../agent/agent-manager.js";
import type { ToolPolicyIdentity } from "../tools/tool-policy.js";

/** 身份由认证适配器产生，Gateway 不接受浏览器提交的用户或能力字段。 */
export interface WebPrincipal {
  readonly userId: string;
  readonly identity: ToolPolicyIdentity;
  readonly profile: AgentSessionProfile;
}

/**
 * Web Gateway 的认证扩展点。
 *
 * 认证适配器只接收 HTTP Authorization 头，不能从请求体或模型文本推导
 * 身份。后续可用多用户会话、OIDC 等实现替换当前的单 Token 适配器。
 */
export interface WebAuthenticator {
  authenticate(
    authorization: string | string[] | undefined,
  ): WebPrincipal | null;
}

export interface BearerTokenAuthenticatorOptions {
  /** 建议使用随机生成的长 Token；Token 永远不会写入日志或响应。 */
  token: string;
  /** 该 Token 代表的服务端用户标识。 */
  userId: string;
  /** 当前 Token 的工具信任等级；认证成功时 authenticated 必须为 true。 */
  identity?: ToolPolicyIdentity;
  /** 当前 Token 可使用的工具能力，由服务端固定。 */
  profile?: AgentSessionProfile;
}

/**
 * 单一服务端 Bearer Token 认证器。
 *
 * V1 有意只映射一个 Token 到一个 Web 用户，先建立安全的 Gateway 边界；
 * 多用户 Token/登录系统可以在不改动 WebGateway 路由的情况下替换该接口。
 */
export class BearerTokenAuthenticator implements WebAuthenticator {
  private readonly token: Buffer;
  private readonly principal: WebPrincipal;

  constructor(options: BearerTokenAuthenticatorOptions) {
    const token = normalizeToken(options.token);
    const userId = normalizeUserId(options.userId);
    const identity = options.identity ?? { authenticated: true };
    if (identity.authenticated !== true) {
      throw new Error("Bearer Token 认证器要求 authenticated=true。");
    }

    this.token = Buffer.from(token, "utf8");
    this.principal = Object.freeze({
      userId,
      identity: Object.freeze({ authenticated: true }),
      profile: options.profile ?? "web-workspace",
    });
  }

  authenticate(
    authorization: string | string[] | undefined,
  ): WebPrincipal | null {
    const candidate = parseBearerToken(authorization);
    if (!candidate || !sameSecret(this.token, candidate)) return null;
    return this.principal;
  }
}

function parseBearerToken(
  authorization: string | string[] | undefined,
): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function sameSecret(expected: Buffer, candidate: string): boolean {
  const actual = Buffer.from(candidate, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}

function normalizeToken(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Web Bearer Token 必须是非空字符串。");
  }
  const token = value.trim();
  if (/\s/.test(token)) {
    throw new TypeError("Web Bearer Token 不能包含空白字符。");
  }
  return token;
}

function normalizeUserId(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Web 认证用户 ID 必须是非空字符串。");
  }
  const userId = value.trim();
  if (userId.length > 256 || [...userId].some(isControlCharacter)) {
    throw new TypeError("Web 认证用户 ID 包含无效字符。");
  }
  return userId;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}
