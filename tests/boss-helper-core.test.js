const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scriptPath = path.join(__dirname, "..", "boss-helper.user.js");
const source = fs.readFileSync(scriptPath, "utf8");

const sandbox = {
  console,
  window: {},
  document: {
    readyState: "loading",
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        style: {},
        appendChild() {},
        addEventListener() {},
        setAttribute() {}
      };
    },
    head: {
      appendChild() {}
    },
    body: {
      appendChild() {}
    }
  },
  GM_getValue(key, fallback) {
    return fallback;
  },
  GM_setValue() {},
  GM_deleteValue() {},
  setTimeout,
  clearTimeout,
  location: {
    hostname: "www.zhipin.com",
    href: "https://www.zhipin.com/web/geek/job"
  }
};

sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.__BOSS_HELPER_ENABLE_TEST_API__ = true;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: scriptPath });

const api = sandbox.__BOSS_HELPER_TESTS__;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert(api, "test api should be exposed");
assert(source.includes("// @match        https://zhipin.com/*"), "script should match bare zhipin.com pages");

assert.deepStrictEqual(api.DEFAULT_SETTINGS.intervalSeconds, 60);
assert.deepStrictEqual(api.DEFAULT_SETTINGS.dailyMax, 150);
assert.strictEqual(api.DEFAULT_SETTINGS.panelCollapsed, false);
assert.strictEqual(api.DEFAULT_SETTINGS.panelHidden, false);
assert.strictEqual(api.DEFAULT_SETTINGS.includeKeywords.includes("测试开发"), true);
assert.strictEqual(api.DEFAULT_SETTINGS.excludeKeywords.includes("网络销售"), true);

assert.strictEqual(api.classifyActionText("立即沟通"), "communicate");
assert.strictEqual(api.classifyActionText(" 立即沟通 "), "communicate");
assert.strictEqual(api.classifyActionText("继续沟通"), "skip");
assert.strictEqual(api.classifyActionText("已沟通"), "skip");
assert.strictEqual(api.classifyActionText("去App与BOSS随时沟通"), "skip");
assert.strictEqual(api.classifyActionText("微信扫码分享"), "skip");
assert.strictEqual(api.classifyActionText("收藏"), "unknown");

assert.strictEqual(api.containsRiskText("请先登录后继续操作"), true);
assert.strictEqual(api.containsRiskText("访问过于频繁，请稍后再试"), true);
assert.strictEqual(api.containsRiskText("这里是正常的职位描述"), false);
assert.strictEqual(api.containsRiskText("负责数字化系统日常运维，建立健全信息安全管理体系和风险控制流程"), false);
assert.strictEqual(api.containsRiskText("登录态良好的普通页面文案"), false);

assert.deepStrictEqual(plain(api.freshStats("2026-07-09")), {
  date: "2026-07-09",
  success: 0,
  skipped: 0,
  failed: 0
});

assert.strictEqual(api.shouldResetStats({ date: "2026-07-08" }, "2026-07-09"), true);
assert.strictEqual(api.shouldResetStats({ date: "2026-07-09" }, "2026-07-09"), false);

assert.strictEqual(api.pickStayButtonText(["继续沟通", "留在此页"]), "留在此页");
assert.strictEqual(api.pickStayButtonText(["继续沟通"]), null);

assert.deepStrictEqual(plain(api.parseKeywords("测试开发, 自动化测试\n测开  QA")), ["测试开发", "自动化测试", "测开", "QA"]);
assert.strictEqual(api.shouldSkipByKeyword("网络销售 15-20K 电话销售经验", api.DEFAULT_SETTINGS), true);
assert.strictEqual(api.shouldSkipByKeyword("测试开发工程师 20-30K 自动化测试经验", api.DEFAULT_SETTINGS), false);
assert.strictEqual(api.shouldSkipByKeyword("软件测试工程师 20-40K 测试经验", api.DEFAULT_SETTINGS), false);
assert.strictEqual(api.shouldSkipByKeyword("后端开发工程师 30-40K Java", api.DEFAULT_SETTINGS), true);
assert.strictEqual(api.shouldSkipBeforeOpenByKeyword("20-40K 本科 经验不限", api.DEFAULT_SETTINGS), false);
assert.strictEqual(api.shouldSkipByKeyword("20-40K 本科 经验不限 软件测试工程师 职位描述 测试方案设计", api.DEFAULT_SETTINGS), false);
assert.strictEqual(api.shouldSkipAfterOpenByKeyword("AI测试开发工程师 负责测试工具落地推进和质量保障", api.DEFAULT_SETTINGS), false);
assert.strictEqual(api.shouldSkipAfterOpenByKeyword("软件测试工程师 负责客户侧质量反馈和测试方案设计", api.DEFAULT_SETTINGS), false);

console.log("boss-helper core tests passed");
