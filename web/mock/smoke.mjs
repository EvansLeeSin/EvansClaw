/**
 * 无头浏览器冒烟测试：用本机 Edge/Chrome 渲染前端页面，
 * 验证「加载会话 → 渲染历史消息 → SSE 流式输出/错误 → 重同步」全链路。
 *
 * 前置条件：mock gateway（或真实 gateway）已在 127.0.0.1:8787 运行，
 * vite dev server 已在 5173 运行。
 *
 *   node web/mock/smoke.mjs
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];

const browserPath = BROWSER_CANDIDATES.find(existsSync);
if (!browserPath) {
  console.error("未找到 Edge/Chrome，无法运行冒烟测试。");
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--disable-gpu", "--no-first-run"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto("http://localhost:5173", { waitUntil: "networkidle0" });

  // 1) 历史消息渲染：mock 会话标题 + 工具卡片 + thinking 块
  const headerText = await page.$eval("header h1", (el) => el.textContent);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const checks = [
    ["会话标题", headerText.includes("Mock 会话")],
    ["thinking 折叠块", bodyText.includes("思考过程")],
    ["工具调用卡片", bodyText.includes("current_time")],
    ["markdown 代码块", bodyText.includes("CREATE TABLE")],
    ["markdown 标题", bodyText.includes("SQLite 简介")],
  ];

  // 2) 创建第二个会话并切回原会话，验证前端使用 scoped API。
  const sessionSelect = 'select[aria-label="选择会话"]';
  const initialSessionId = await page.$eval(
    sessionSelect,
    (element) => element.value,
  );
  const initialSessionCount = await page.$$eval(
    `${sessionSelect} option`,
    (options) => options.length,
  );
  checks.push(["会话选择器", Boolean(initialSessionId)]);
  await page.click('button[aria-label="新建会话"]');
  // 等待选中值和选项列表都完成 React 提交，避免只观察到中间态。
  await page.waitForFunction(
    (selector, previousId, previousCount) => {
      const select = document.querySelector(selector);
      return (
        select?.value !== previousId &&
        select?.querySelectorAll("option").length === previousCount + 1
      );
    },
    { timeout: 15000 },
    sessionSelect,
    initialSessionId,
    initialSessionCount,
  );
  const sessionCount = await page.$$eval(
    `${sessionSelect} option`,
    (options) => options.length,
  );
  checks.push(["创建独立会话", sessionCount === initialSessionCount + 1]);
  await page.select(sessionSelect, initialSessionId);
  await page.waitForFunction(
    () => document.body.innerText.includes("SQLite 简介"),
    { timeout: 15000 },
  );

  // 3) 发送消息 → SSE 流式输出 → 完成后重同步
  // 先展开工具调用卡片，验证参数与结果都在（折叠时 innerText 不含隐藏内容）。
  await page.click("details.group\\/tool summary");
  const expandedText = await page.evaluate(() => document.body.innerText);
  checks.push(["工具调用参数", expandedText.includes("current_time")]);
  checks.push(["工具执行结果", expandedText.includes("Asia/Shanghai")]);

  await page.type("textarea", "你好，来一段流式回复");
  await page.click('button[aria-label="发送"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("流式回复"),
    { timeout: 15000 },
  );
  // done 之后前端会重新拉取全量消息，工具卡片数量应保持稳定
  await page.waitForFunction(
    () => document.body.innerText.includes("回复完毕"),
    { timeout: 15000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterText = await page.evaluate(() => document.body.innerText);
  checks.push(["用户消息上屏", afterText.includes("你好，来一段流式回复")]);
  checks.push(["流式回复渲染", afterText.includes("这是 mock 网关的流式回复")]);

  // 3) 审批事件 → 卡片展示脱敏参数 → 点击允许 → 继续完成本轮。
  await page.type("textarea", "__mock_approval__");
  await page.click('button[aria-label="发送"]');
  await page.waitForSelector('[data-approval-status="pending"]', {
    timeout: 15000,
  });
  const approvalText = await page.evaluate(() => document.body.innerText);
  checks.push(["审批卡片展示", approvalText.includes("需要确认工具操作")]);
  checks.push(["审批参数脱敏", approvalText.includes("[已隐藏]")]);
  checks.push(["审批按钮可用", await page.$('button[aria-label="允许一次"]') !== null]);
  await page.click('[data-approval-status="pending"] button[aria-label="允许一次"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("审批已通过，工具操作完成"),
    { timeout: 15000 },
  );
  checks.push(["批准后继续对话", (await page.evaluate(() => document.body.innerText)).includes("审批已通过，工具操作完成")]);

  await page.type("textarea", "__mock_approval__");
  await page.click('button[aria-label="发送"]');
  await page.waitForSelector('[data-approval-status="pending"]', {
    timeout: 15000,
  });
  await page.click('[data-approval-status="pending"] button[aria-label="拒绝审批"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("审批已拒绝，工具没有执行"),
    { timeout: 15000 },
  );
  checks.push(["拒绝后不执行工具", (await page.evaluate(() => document.body.innerText)).includes("审批已拒绝，工具没有执行")]);

  // 5) SSE error → refetch 已部分持久化消息，但错误横幅必须继续保留。
  await page.type("textarea", "__mock_error__");
  await page.click('button[aria-label="发送"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Mock 对话失败") ?? false,
    { timeout: 15000 },
  );
  // 留出 refetch 完成时间：旧实现会在这里把错误状态清空。
  await new Promise((resolve) => setTimeout(resolve, 500));
  const errorState = await page.evaluate(() => ({
    alert: document.querySelector('[role="alert"]')?.textContent ?? "",
    body: document.body.innerText,
  }));
  checks.push([
    "SSE 错误提示保留",
    errorState.alert.includes("对话请求失败：Mock 对话失败"),
  ]);
  checks.push([
    "失败轮次同步",
    errorState.body.includes("__mock_error__") && errorState.alert.includes("重试"),
  ]);

  let failed = 0;
  for (const [name, passed] of checks) {
    console.log(`${passed ? "✓" : "✗"} ${name}`);
    if (!passed) failed++;
  }
  if (errors.length) {
    console.log("\n浏览器错误：");
    for (const error of errors) console.log(`  ${error}`);
    failed++;
  }

  await page.screenshot({ path: "mock/smoke.png", fullPage: false });
  console.log(`\n截图：web/mock/smoke.png`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
