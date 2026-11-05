#!/usr/bin/env node
/**
 * 基线校验 —— 只跑一遍，就能判断「这次改动有没有引入新问题」。
 *
 * 以前的做法是：建一个 worktree 回到改动前，跑第二遍 tsc，再拿两份输出比对。
 * 两遍 tsc 各要几分钟，等于每次验证多花一倍时间。
 *
 * 这里改成把「已知的历史遗留问题」存成快照（.workbuddy/baseline/checks.json），
 * 每次只跑一遍、跟快照比集合：多出来的就是新引入的，少掉的就是顺手修好的。
 *
 * 用法：
 *   node scripts/check-baseline.mjs            跑 tsc 并对比
 *   node scripts/check-baseline.mjs --vitest   连单测一起（较慢，几分钟）
 *   node scripts/check-baseline.mjs --update   把当前结果记为新基线
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, "web");
// 基线跟着脚本走，是要入库的团队资产：
// 放 .workbuddy/ 会被 git exclude 掉，换台机器就等于没有基线。
const BASELINE_FILE = join(ROOT, "scripts", "baseline", "checks.json");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const UPDATE = has("update");
const RUN_VITEST = has("vitest");
const RUN_TSC = !has("vitest") || has("tsc");

const C = process.stdout.isTTY
    ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" }
    : { dim: "", red: "", green: "", yellow: "", cyan: "", bold: "", reset: "" };
const log = (...args) => console.log(...args);
const step = (text) => log(`\n${C.bold}▸ ${text}${C.reset}`);

function readBaseline() {
    if (!existsSync(BASELINE_FILE)) return null;
    try {
        return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    } catch {
        return null;
    }
}

// ── tsc ────────────────────────────────────────────────────────────────────
/**
 * 把错误行压成可比较的指纹：丢掉行列号，只留「文件 + 错误码 + 消息」。
 * 行号在合并后一定会漂移，带行号比对会把同一批错误全判成「新增」。
 *
 * 注意 Windows 下 tsc 输出是 CRLF，而正则里的 `.` 不匹配 `\r`，
 * 不先剥掉行尾 `\r` 的话 `(.*)$` 会整批失配（一条都解析不出来）。
 */
function tscFingerprint(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (!m) return null;
    const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    // 消息原样保留：把引号里的名字抹掉会让「Property 'a'」和「Property 'b'」
    // 变成同一条，改名或换字段就查不出来了。真要区分改名，看「新增 N / 消失 N」即可。
    const message = m[5].trim();
    return `${file}|${m[4]}|${message}`;
}

function runTsc() {
    step("类型检查（tsc）");
    const started = Date.now();
    const res = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], {
        cwd: WEB,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    });
    if (res.error) throw res.error;
    const out = `${res.stdout || ""}${res.stderr || ""}`;
    const errors = out.split(/\r?\n/).map(tscFingerprint).filter(Boolean);
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    log(`  ${C.dim}完成，耗时 ${seconds}s${C.reset}`);
    return errors;
}

// ── vitest ─────────────────────────────────────────────────────────────────
function runVitest() {
    step("单元测试（vitest）");
    const started = Date.now();
    const res = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", "--outputFile=vitest-report.json"], {
        cwd: WEB,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    });
    if (res.error) throw res.error;
    const reportPath = join(WEB, "vitest-report.json");
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    log(`  ${C.dim}完成，耗时 ${seconds}s${C.reset}`);
    if (!existsSync(reportPath)) {
        log(`  ${C.yellow}!${C.reset} 没拿到 vitest 报告，跳过对比`);
        return null;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    rmSync(reportPath, { force: true }); // 临时报告，别留在工作区里
    const failed = [];
    for (const file of report.testResults || []) {
        for (const test of file.assertionResults || []) {
            if (test.status === "failed") {
                const rel = file.name.replace(/\\/g, "/").split("/web/").pop();
                failed.push(`${rel} > ${test.fullName || test.title}`);
            }
        }
    }
    return { failed, total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0 };
}

// ── 多重集差集 ─────────────────────────────────────────────────────────────
/** 相同消息可能有多个（同一文件多处），按次数扣减才不会误报。 */
function diffMultiset(current, baseline) {
    const pool = new Map();
    for (const item of baseline) pool.set(item, (pool.get(item) || 0) + 1);
    const added = [];
    for (const item of current) {
        const n = pool.get(item) || 0;
        if (n > 0) pool.set(item, n - 1);
        else added.push(item);
    }
    const removed = [];
    for (const [item, n] of pool) for (let i = 0; i < n; i += 1) removed.push(item);
    return { added, removed };
}

function reportDiff(label, current, baseline, format) {
    if (!baseline) {
        log(`  ${C.yellow}!${C.reset} 没有 ${label} 基线，当前 ${current.length} 项已记录`);
        return { added: current, removed: [] };
    }
    const { added, removed } = diffMultiset(current, baseline);
    const delta = current.length - baseline.length;
    const trend = delta === 0 ? "" : delta > 0 ? `${C.red}+${delta}${C.reset}` : `${C.green}${delta}${C.reset}`;
    log(`  当前 ${current.length} / 基线 ${baseline.length}${trend ? `（${trend}）` : "（持平）"}`);

    if (!added.length) {
        log(`  ${C.green}✓${C.reset} 没有新增问题`);
    } else {
        log(`  ${C.red}✗ 新增 ${added.length} 项：${C.reset}`);
        for (const item of added.slice(0, 20)) log(`      ${C.red}${format(item)}${C.reset}`);
        if (added.length > 20) log(`      ${C.dim}…另 ${added.length - 20} 项${C.reset}`);
    }
    if (removed.length) {
        log(`  ${C.green}✓${C.reset} 比基线少了 ${removed.length} 项（顺手修好的）`);
        for (const item of removed.slice(0, 5)) log(`      ${C.dim}${format(item)}${C.reset}`);
        if (removed.length > 5) log(`      ${C.dim}…另 ${removed.length - 5} 项${C.reset}`);
    }
    return { added, removed };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const baseline = readBaseline();
const next = { generatedAt: new Date().toISOString(), ...(baseline || {}) };
let hasNewProblem = false;

if (RUN_TSC) {
    const errors = runTsc();
    const { added } = reportDiff("tsc", errors, baseline?.tsc?.errors, (item) => item.replace(/\|/g, "  "));
    if (added.length) hasNewProblem = true;
    next.tsc = { count: errors.length, errors };
}

if (RUN_VITEST) {
    const result = runVitest();
    if (result) {
        const { added } = reportDiff("vitest", result.failed, baseline?.vitest?.failed, (item) => item);
        if (added.length) hasNewProblem = true;
        next.vitest = { failed: result.failed, total: result.total, passed: result.passed };
    }
}

if (UPDATE) {
    mkdirSync(dirname(BASELINE_FILE), { recursive: true });
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
    log(`\n${C.cyan}基线已更新${C.reset} → ${BASELINE_FILE.replace(/\\/g, "/").replace(`${ROOT.replace(/\\/g, "/")}/`, "")}`);
} else {
    log(
        hasNewProblem
            ? `\n${C.red}有新增问题，不要当成「和基线一样」放过去。${C.reset}`
            : `\n${C.green}与基线一致${C.reset}，可以继续。${C.dim}（确认要接受当前结果时用 --update）${C.reset}`,
    );
    if (!baseline) log(`${C.yellow}首次运行：请确认后用 --update 建立基线${C.reset}`);
}
process.exit(hasNewProblem ? 1 : 0);
