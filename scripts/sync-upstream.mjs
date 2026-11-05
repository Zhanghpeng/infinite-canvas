#!/usr/bin/env node
/**
 * 同步上游（infinite-canvas）—— 只拉代码，不重复下二进制。
 *
 * 背景：本项目 fork 自 ZhuYichuan/infinite-canvas，需要长期跟上游。
 * 仓库里 >100KB 的文件只有 20 个运镜 mp4 和 1 张 png，但它们占了全部历史增量的绝大部分。
 * 而本机直连 GitHub 单连接只有 ~28KB/s，一次 28MB 的 fetch 要跑半小时还会中断。
 *
 * 所以这里把「拉什么」和「怎么拉」拆开：
 *   1. fetch 带 --filter=blob:limit，只要 commit / tree / 小文件，通常几秒完成
 *   2. 缺的大 blob 先从**本地工作区**算 hash 写回对象库（本地通常已有，零网络）
 *   3. 只有上游真的改过、本地也没有的，才走网络单个下载
 *   4. 用 merge-tree 预演冲突，不改工作区
 *
 * 用法：
 *   node scripts/sync-upstream.mjs              预演（fetch + 补对象 + 冲突预判，不动工作区）
 *   node scripts/sync-upstream.mjs --apply      执行合并
 *   node scripts/sync-upstream.mjs --only-fetch 只发 fetch
 *   可选：--remote=upstream  --branch=main  --blob-limit=100k
 *
 * 设计取舍见 docs/content/docs/guide/sync-upstream.mdx
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GIT_DIR = join(ROOT, ".git");
const PROMISOR_BACKUP = join(GIT_DIR, "promisor-disabled");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    const [, value] = hit.split("=");
    return value === undefined ? true : value;
};

const REMOTE = flag("remote", "upstream");
/** 上游要跟踪的分支。 */
const UPSTREAM_BRANCH = flag("branch", "main");
/** 合并到哪个本地分支，留空表示当前分支。 */
const INTO = flag("into", null);
const BLOB_LIMIT = flag("blob-limit", "100k");
const ONLY_FETCH = Boolean(flag("only-fetch", false));
const APPLY = Boolean(flag("apply", false));
const CONCURRENCY = Number(flag("concurrency", 6));

// ── 输出 ────────────────────────────────────────────────────────────────────
const C = process.stdout.isTTY
    ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" }
    : { dim: "", red: "", green: "", yellow: "", cyan: "", bold: "", reset: "" };
const log = (...args) => console.log(...args);
const step = (text) => log(`\n${C.bold}▸ ${text}${C.reset}`);
const ok = (text) => log(`  ${C.green}✓${C.reset} ${text}`);
const warn = (text) => log(`  ${C.yellow}!${C.reset} ${text}`);
const fail = (text) => log(`  ${C.red}✗${C.reset} ${text}`);

if (argv.includes("--help") || argv.includes("-h")) {
    log(`用法：node scripts/sync-upstream.mjs [选项]

默认只预演（拉取 + 补对象 + 冲突预判），不改工作区。

  --apply              确认后真正执行合并
  --only-fetch         只 fetch
  --branch=<名称>      要跟踪的上游分支，默认 main
  --into=<名称>        合并到哪个本地分支，默认当前分支
  --remote=<名称>      远端名，默认 upstream
  --blob-limit=<大小>  过滤阈值，默认 100k（0 表示不过滤）
  --concurrency=<n>    补对象时的并发，默认 6
`);
    process.exit(0);
}

// ── git 封装 ────────────────────────────────────────────────────────────────
/** 清掉代理环境变量：本机代理对 github.com 返回 502，直连反而通。 */
function directEnv() {
    const env = { ...process.env };
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) delete env[key];
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";
    return env;
}

function git(args, options = {}) {
    const { input, allowFail = false, env, timeout, quiet = true } = options;
    const res = spawnSync("git", args, {
        cwd: ROOT,
        input,
        env: env ?? process.env,
        timeout: timeout || undefined,
        maxBuffer: 1 << 30,
        encoding: "utf8",
        stdio: input === undefined ? ["ignore", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"] : ["pipe", "pipe", "pipe"],
    });
    if (res.error) {
        if (allowFail) return { ok: false, out: "", err: String(res.error), status: -1 };
        throw res.error;
    }
    const out = (res.stdout || "").trim();
    const err = (res.stderr || "").trim();
    if (res.status !== 0 && !allowFail) {
        throw new Error(`git ${args.join(" ")} 失败（退出码 ${res.status}）\n${err || out}`.trim());
    }
    return { ok: res.status === 0, out, err, status: res.status };
}

/** 合并落点：默认就是当前分支，避免把「上游分支名」和「本地目标分支」混为一谈。 */
const LOCAL_BRANCH = INTO ?? git(["rev-parse", "--abbrev-ref", "HEAD"]).out;

// ── 步骤 1：前置检查 ────────────────────────────────────────────────────────
function preflight() {
    step("前置检查");
    const dirty = git(["status", "--porcelain"]).out;
    if (dirty) {
        const lines = dirty.split("\n");
        warn(`工作区有 ${lines.length} 处未提交改动：`);
        for (const line of lines.slice(0, 8)) log(`      ${C.dim}${line}${C.reset}`);
        if (lines.length > 8) log(`      ${C.dim}…另 ${lines.length - 8} 处${C.reset}`);
        if (APPLY) {
            fail("有未提交改动时不执行合并。先提交或 stash，再用 --apply。");
            process.exit(1);
        }
        warn("预演模式继续（不会动工作区），合并前请先处理。");
    } else {
        ok("工作区干净");
    }

    const head = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
    if (head !== LOCAL_BRANCH) warn(`当前分支是 ${head}，合并会落到 ${LOCAL_BRANCH}`);
    else ok(`当前分支 ${head}`);

    const url = git(["remote", "get-url", REMOTE], { allowFail: true }).out;
    if (!url) {
        fail(`找不到远端 ${REMOTE}。先执行：git remote add ${REMOTE} https://github.com/ZhuYichuan/infinite-canvas.git`);
        process.exit(1);
    }
    ok(`远端 ${REMOTE} → ${url}`);
    return { url, head };
}

// ── 步骤 2：fetch（只拉代码） ──────────────────────────────────────────────
function fetchUpstream() {
    step(`拉取上游（只拉代码，跳过 >${BLOB_LIMIT} 的文件）`);
    if (BLOB_LIMIT === "0") {
        // 想拉全量时得把持久化的过滤器也摘掉，否则 fetch 仍会沿用旧阈值
        git(["config", "--unset-all", `remote.${REMOTE}.partialclonefilter`], { allowFail: true });
    }
    const filterArgs = BLOB_LIMIT === "0" ? [] : [`--filter=blob:limit=${BLOB_LIMIT}`];
    const started = Date.now();
    const res = git(
        ["fetch", "--no-tags", ...filterArgs, REMOTE, `+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${REMOTE}/${UPSTREAM_BRANCH}`],
        { env: directEnv(), timeout: 600_000 },
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!res.ok) {
        fail(`fetch 失败：${res.err || res.out}`);
        process.exit(1);
    }
    ok(`耗时 ${seconds}s`);
    // 清掉 fetch 中断留下的临时包（git 不会自动回收，越积越多会拖慢 gc）
    const packDir = join(GIT_DIR, "objects", "pack");
    if (existsSync(packDir)) {
        const stale = readdirSync(packDir).filter((f) => f.startsWith("tmp_pack_"));
        if (stale.length) {
            mkdirSync(PROMISOR_BACKUP, { recursive: true });
            for (const f of stale) {
                try {
                    renameSync(join(packDir, f), join(PROMISOR_BACKUP, f));
                } catch {
                    /* 被占用就下次再说 */
                }
            }
            warn(`清理了 ${stale.length} 个中断残留的临时包`);
        }
    }
}

// ── 步骤 3：增量判断 ────────────────────────────────────────────────────────
function inspectRange() {
    const head = `${REMOTE}/${UPSTREAM_BRANCH}`;
    git(["rev-parse", "--verify", head], { allowFail: false });
    const count = Number(git(["rev-list", "--count", `${LOCAL_BRANCH}..${head}`]).out || 0);
    const base = git(["merge-base", LOCAL_BRANCH, head]).out;
    return { head, count, base };
}

// ── 步骤 4：partial clone 的开关控制 ───────────────────────────────────────
/**
 * fetch --filter 会把远端标记为 promisor。之后任何查缺失对象的命令
 * （cat-file --batch-check / checkout）都会触发 lazy fetch 去联网，
 * 而这里我们要自己控制补对象，所以检查期间必须先摘掉 promisor 身份。
 * 对象补齐后再把配置恢复回来——这样手敲 `git fetch upstream` 也自动只拉代码。
 * 详见 docs 里记录的那次 502 卡死。
 */
function disablePromisor() {
    const keys = git(["config", "--get-regexp", "^remote\\..*\\.promisor$"], { allowFail: true }).out;
    const saved = [];
    for (const line of keys.split("\n").filter(Boolean)) {
        const [key, value] = line.split(" ");
        saved.push({ key, value });
        git(["config", "--unset-all", key], { allowFail: true });
    }
    const filters = git(["config", "--get-regexp", "^remote\\..*\\.partialclonefilter$"], { allowFail: true }).out;
    for (const line of filters.split("\n").filter(Boolean)) {
        const [key, value] = line.split(" ");
        saved.push({ key, value });
        git(["config", "--unset-all", key], { allowFail: true });
    }
    // pack 旁边的 .promisor 标记文件同样会让 git 认为这包「按需补」；
    // 补齐完成后这些包确实是完整的，所以标记可以永久移走。
    const packDir = join(GIT_DIR, "objects", "pack");
    let moved = 0;
    if (existsSync(packDir)) {
        mkdirSync(PROMISOR_BACKUP, { recursive: true });
        for (const f of readdirSync(packDir).filter((name) => name.endsWith(".promisor"))) {
            try {
                renameSync(join(packDir, f), join(PROMISOR_BACKUP, f));
                moved += 1;
            } catch {
                /* 忽略 */
            }
        }
    }
    return { saved, moved };
}

/** 对象补齐后恢复远端配置，保留「默认只拉代码」的行为。 */
function restorePromisor(saved) {
    for (const { key, value } of saved) git(["config", key, value], { allowFail: true });
}

// ── 步骤 5：找出缺失的 blob ────────────────────────────────────────────────
function listBlobs(rev) {
    const out = git(["ls-tree", "-r", rev]).out;
    const map = new Map(); // sha -> path
    for (const line of out.split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const meta = line.slice(0, tab).split(" ");
        if (meta[1] !== "blob") continue;
        const path = line.slice(tab + 1);
        if (!map.has(meta[2])) map.set(meta[2], path);
    }
    return map;
}

function findMissingBlobs(revs) {
    const wanted = new Map(); // sha -> path
    for (const rev of revs) {
        if (!rev) continue;
        for (const [sha, path] of listBlobs(rev)) if (!wanted.has(sha)) wanted.set(sha, path);
    }
    const shas = [...wanted.keys()];
    if (!shas.length) return [];
    const out = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: shas.join("\n") }).out;
    const lines = out.split("\n");
    const missing = [];
    shas.forEach((sha, i) => {
        if ((lines[i] || "").includes("missing")) missing.push({ sha, path: wanted.get(sha) });
    });
    return missing;
}

// ── 步骤 6：补齐 blob（本地优先，网络兜底） ───────────────────────────────
const sha1OfBlob = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

/** 从工作区把同内容的文件写回对象库——不联网。 */
function tryFromWorktree({ sha, path }) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) return false;
    // hash-object -w 会顺带把对象写进库，返回值即内容 sha
    const got = git(["hash-object", "-w", "--", path], { allowFail: true }).out;
    return got === sha;
}

function parseOwnerRepo(url) {
    const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

async function fetchBlobFromApi(repo, sha) {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/blobs/${sha}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "infinite-canvas-sync" },
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const body = await res.json();
    if (body.encoding !== "base64" || !body.content) throw new Error("返回格式不符");
    const buf = Buffer.from(body.content.replace(/\n/g, ""), "base64");
    if (sha1OfBlob(buf) !== sha) throw new Error("sha 校验失败");
    const tmp = join(PROMISOR_BACKUP, sha);
    mkdirSync(PROMISOR_BACKUP, { recursive: true });
    writeFileSync(tmp, buf);
    git(["hash-object", "-w", "-t", "blob", tmp]);
    rmSync(tmp, { force: true });
    return buf.length;
}

async function restoreBlobs(missing, repo) {
    step(`补齐缺失对象（${missing.length} 个）`);
    if (!missing.length) {
        ok("没有缺失，跳过");
        return { failed: [] };
    }
    const fromWorktree = [];
    const needNetwork = [];
    for (const item of missing) {
        if (tryFromWorktree(item)) fromWorktree.push(item);
        else needNetwork.push(item);
    }
    if (fromWorktree.length) ok(`本地工作区命中 ${fromWorktree.length} 个（零网络）`);

    const failed = [];
    if (needNetwork.length) {
        log(`  ${C.dim}需要联网下载 ${needNetwork.length} 个${C.reset}`);
        let cursor = 0;
        const work = async () => {
            while (cursor < needNetwork.length) {
                const item = needNetwork[cursor++];
                let done = false;
                for (let attempt = 1; attempt <= 2 && !done; attempt += 1) {
                    try {
                        const bytes = await fetchBlobFromApi(repo, item.sha);
                        ok(`${item.path} ${(bytes / 1024).toFixed(0)}KB`);
                        done = true;
                    } catch (error) {
                        if (attempt === 2) {
                            fail(`${item.path} — ${error.message}`);
                            failed.push(item);
                        }
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, needNetwork.length) }, work));
    }
    return { failed, fromWorktree: fromWorktree.length, needNetwork: needNetwork.length };
}

// ── 步骤 7：冲突预演（不改工作区） ────────────────────────────────────────
function previewMerge(base, head) {
    step("冲突预演（merge-tree，不改工作区）");
    const res = git(["merge-tree", "--write-tree", "--name-only", LOCAL_BRANCH, head], { allowFail: true });
    // 输出首行是合并后的 tree，其余是冲突文件；退出码 1 表示有冲突
    const lines = res.out.split("\n").filter(Boolean);
    const conflicts = lines.slice(1).map((line) => line.trim()).filter(Boolean);
    return conflicts;
}

/** 双方都改过的文件才是真正会打架的地方，动态算比维护黑名单准。 */
function overlapFiles(base, head) {
    const ours = new Set(git(["diff", "--name-only", `${base}...${LOCAL_BRANCH}`]).out.split("\n").filter(Boolean));
    const theirs = git(["diff", "--name-only", `${base}...${head}`]).out.split("\n").filter(Boolean);
    return theirs.filter((path) => ours.has(path));
}

function countConflictMarkers(files) {
    const result = new Map();
    for (const file of files) {
        const abs = join(ROOT, file);
        if (!existsSync(abs)) continue;
        const res = spawnSync("git", ["grep", "-c", "^<<<<<<<", "--", file], { cwd: ROOT, encoding: "utf8" });
        const n = Number((res.stdout || "").split(":").pop() || 0);
        if (n) result.set(file, n);
    }
    return result;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
    const started = Date.now();
    const { url } = preflight();
    const repo = parseOwnerRepo(url);

    fetchUpstream();

    // 先摘掉 promisor，后面查缺失对象才不会偷偷联网
    const promisor = disablePromisor();
    if (promisor.saved.length || promisor.moved) {
        log(`  ${C.dim}已暂时关闭 promisor（${promisor.saved.length} 项配置 / ${promisor.moved} 个包标记）${C.reset}`);
    }

    const { head, count, base } = inspectRange();

    if (!count) {
        restorePromisor(promisor.saved);
        ok(`${LOCAL_BRANCH} 已是最新，上游没有新提交`);
        log(`\n${C.green}完成${C.reset}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
        return;
    }
    ok(`上游有 ${count} 个新提交`);

    if (ONLY_FETCH) {
        restorePromisor(promisor.saved);
        log(`\n${C.green}已拉取，工作区未动${C.reset}`);
        return;
    }

    const missing = findMissingBlobs([base, head]);
    const { failed } = await restoreBlobs(missing, repo);
    if (failed.length) {
        restorePromisor(promisor.saved);
        fail(`还有 ${failed.length} 个对象补不上，合并会失败。`);
        log(`  ${C.dim}可以单独重试：node scripts/sync-upstream.mjs --only-fetch 后再跑一次，或检查网络${C.reset}`);
        process.exit(1);
    }
    restorePromisor(promisor.saved);

    step("改动概览");
    const changed = git(["diff", "--name-only", `${base}...${head}`]).out.split("\n").filter(Boolean);
    ok(`上游改动 ${changed.length} 个文件`);
    const overlap = overlapFiles(base, head);
    if (overlap.length) {
        warn(`其中 ${overlap.length} 个文件本地也改过（合并时需要留意）：`);
        for (const file of overlap) log(`      ${C.yellow}${file}${C.reset}`);
    } else {
        ok("与本地改动没有重叠");
    }

    const conflicts = previewMerge(base, head);
    if (conflicts.length) {
        warn(`预演结果：${conflicts.length} 个文件会冲突`);
        for (const file of conflicts) log(`      ${C.red}${file}${C.reset}`);
    } else {
        ok("预演结果：可以干净合并");
    }

    if (!APPLY) {
        log(`\n${C.cyan}预演完成${C.reset}，工作区未改动。`);
        log(`确认后执行：${C.bold}node scripts/sync-upstream.mjs --apply${C.reset}`);
        log(`${C.dim}耗时 ${((Date.now() - started) / 1000).toFixed(1)}s${C.reset}`);
        return;
    }

    step("执行合并");
    const merge = git(["merge", "--no-edit", head], { allowFail: true });
    if (merge.ok) {
        ok("合并成功，没有冲突");
        log(`\n${C.green}下一步${C.reset}: node scripts/check-baseline.mjs  # 确认没引入新问题`);
        return;
    }
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
    if (!unmerged.length) {
        fail(`合并失败：${merge.err || merge.out}`);
        process.exit(1);
    }
    warn(`${unmerged.length} 个文件有冲突，已停在合并中：`);
    const markers = countConflictMarkers(unmerged);
    for (const file of unmerged) {
        const blocks = markers.get(file);
        log(`      ${C.red}${file}${C.reset}${blocks ? ` ${C.dim}（${blocks} 处冲突）${C.reset}` : ""}`);
    }
    log(`\n解决后：git add <文件> && git commit`);
    log(`${C.dim}已开启 rerere：同样的冲突下次会自动套用这次的解法${C.reset}`);
    log(`${C.dim}想放弃：git merge --abort${C.reset}`);
}

main().catch((error) => {
    fail(error.message);
    process.exit(1);
});
