import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DefaultToolPolicy,
  type ToolPolicyRequest,
} from "../src/tools/tool-policy.js";
import type { ToolRisk } from "../src/tools/tool-types.js";

const context = {
  sessionId: "personal",
  conversationId: "personal",
  channel: "cli",
  userId: "local",
};

function request(
  risk: ToolRisk,
  overrides: Partial<ToolPolicyRequest> = {},
): ToolPolicyRequest {
  return {
    context,
    identity: { authenticated: true },
    tool: {
      name: `${risk}_test`,
      toolset: "test",
      risk,
      source: "builtin",
    },
    ...overrides,
  };
}

test("默认策略允许完整上下文中的只读工具", () => {
  const policy = new DefaultToolPolicy();

  assert.deepEqual(policy.evaluate(request("read")), {
    action: "allow",
    ruleId: "risk.read",
    reason: "只读工具且调用上下文完整，可以自动执行。",
  });
});

test("默认策略要求可信身份确认写入和外部操作", () => {
  const policy = new DefaultToolPolicy({ approvalTtlMs: 15_000 });

  for (const risk of ["write", "external"] as const) {
    assert.deepEqual(policy.evaluate(request(risk)), {
      action: "ask",
      ruleId: `risk.${risk}.confirmation`,
      reason: "该工具可能产生副作用，需要用户确认后执行。",
      confirmation: {
        level: "standard",
        expiresInMs: 15_000,
      },
    });
  }
});

test("默认策略拒绝破坏性工具且不降级为普通确认", () => {
  const decision = new DefaultToolPolicy().evaluate(request("destructive"));

  assert.equal(decision.action, "deny");
  assert.equal(decision.ruleId, "risk.destructive.default-deny");
  assert.equal(decision.confirmation, undefined);
});

test("不可信身份不能调用敏感工具，但仍可使用已隔离的只读工具", () => {
  const policy = new DefaultToolPolicy();

  assert.equal(
    policy.evaluate(
      request("read", { identity: { authenticated: false } }),
    ).action,
    "allow",
  );
  for (const risk of ["write", "external", "destructive"] as const) {
    const decision = policy.evaluate(
      request(risk, { identity: { authenticated: false } }),
    );
    assert.equal(decision.action, "deny");
    assert.equal(decision.ruleId, "identity.untrusted");
  }
});

test("缺失上下文、身份或工具元数据时 fail closed", () => {
  const policy = new DefaultToolPolicy();

  const incompleteContext = policy.evaluate(
    request("read", {
      context: { ...context, userId: "" },
    }),
  );
  assert.equal(incompleteContext.action, "deny");
  assert.equal(incompleteContext.ruleId, "context.incomplete");

  const unknownIdentity = policy.evaluate(
    request("read", { identity: undefined as never }),
  );
  assert.equal(unknownIdentity.action, "deny");
  assert.equal(unknownIdentity.ruleId, "identity.unknown");

  const invalidTool = policy.evaluate(
    request("read", {
      tool: {
        name: "",
        toolset: "test",
        risk: "read",
        source: "builtin",
      },
    }),
  );
  assert.equal(invalidTool.action, "deny");
  assert.equal(invalidTool.ruleId, "tool.invalid");
});

test("未知风险和来源即使绕过 TypeScript 也会被拒绝", () => {
  const policy = new DefaultToolPolicy();

  const unknownRisk = policy.evaluate(
    request("read", {
      tool: {
        name: "unknown_risk",
        toolset: "test",
        risk: "network" as never,
        source: "builtin",
      },
    }),
  );
  assert.equal(unknownRisk.action, "deny");
  assert.equal(unknownRisk.ruleId, "tool.invalid");

  const unknownSource = policy.evaluate(
    request("read", {
      tool: {
        name: "unknown_source",
        toolset: "test",
        risk: "read",
        source: "unknown" as never,
      },
    }),
  );
  assert.equal(unknownSource.action, "deny");
  assert.equal(unknownSource.ruleId, "tool.invalid");
});

test("确认有效期配置必须是正整数", () => {
  assert.throws(
    () => new DefaultToolPolicy({ approvalTtlMs: 0 }),
    /approvalTtlMs 必须是正整数/,
  );
  assert.throws(
    () => new DefaultToolPolicy({ approvalTtlMs: 1.5 }),
    /approvalTtlMs 必须是正整数/,
  );
});
