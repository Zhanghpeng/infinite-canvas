#!/usr/bin/env node
/**
 * 系统预设资产的本地镜像脚本。
 *
 * 图片二进制不进仓库（体量太大），但境外 CDN（*.pages.dev）在国内直连经常整片超时，
 * 素材库就会出现「网格空白 / 插入画布拿不到图」。跑一次本脚本把图拉到
 * `web/public/system-presets/`，运行时前端会读同目录的 manifest.json，命中即走同源。
 *
 * 目录按各 CDN 原样镜像，前端取址规则见 web/src/lib/assets/preset-local.ts。
 *
 * 用法：
 *   node scripts/fetch-system-presets.mjs                 # 全量拉取（约 5.5GB）
 *   node scripts/fetch-system-presets.mjs --only=pose     # 只拉姿势（约 790MB）
 *   node scripts/fetch-system-presets.mjs --only=pose --no-full   # 只拉姿势缩略图（约 23MB）
 *   node scripts/fetch-system-presets.mjs --dry-run       # 只统计清单，不下载
 *   node scripts/fetch-system-presets.mjs --force         # 覆盖已存在的文件
 *
 * 断点续传：已存在且非空的文件默认跳过，中断后重跑即可继续。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "web/src/data/system-presets");
const OUT_DIR = path.join(ROOT, "web/public/system-presets");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

const CDN = {
  pose: "https://ai-pose-gallery.pages.dev",
  poseDepth: "https://ai-pose-depth-gallery.pages.dev",
  costume: "https://ai-costume-gallery.pages.dev",
  costumeFull: "https://ai-costume-anime-gallery.pages.dev",
  portrait: "https://ai-portrait-gallery.pages.dev",
};
const INDEX_BASE = "https://deeyu.github.io/ai-costume-gallery-zh";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((item) => item.startsWith(`${flag}=`))?.split("=")[1];

const ONLY = (valueOf("--only") || "pose,costume,portrait,anime").split(",").map((item) => item.trim()).filter(Boolean);
const WITH_FULL = !has("--no-full");
const DRY_RUN = has("--dry-run");
const FORCE = has("--force");
const CONCURRENCY = Number(valueOf("--concurrency")) || 8;

const wants = (group) => ONLY.includes(group);

const readJson = async (file) => JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "infinite-canvas-preset-fetch/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
};

/** 远端 URL → 本地相对路径：直接沿用 CDN 的 pathname，保持目录结构与上游一致。 */
const relFromUrl = (prefix, url) => {
  try {
    return path.posix.join(prefix, new URL(url).pathname);
  } catch {
    return "";
  }
};

const ANGLES = ["front", "side", "diag", "high", "low"];

async function buildTasks() {
  /** @type {{ rel: string, url: string }[]} */
  const tasks = [];

  if (wants("pose")) {
    const poses = await readJson("poses.json");
    for (const pose of poses.assets) {
      for (const angle of pose.angles?.length ? pose.angles : ANGLES) {
        const file = `${pose.id}_${angle}`;
        tasks.push({ rel: `pose/thumbs/${file}.jpg`, url: `${CDN.pose}/thumbs/${file}.jpg` });
        tasks.push({ rel: `pose-depth/thumbs/${file}.jpg`, url: `${CDN.poseDepth}/thumbs/${file}.jpg` });
        if (WITH_FULL) {
          tasks.push({ rel: `pose/img/${file}.png`, url: `${CDN.pose}/img/${file}.png` });
          tasks.push({ rel: `pose-depth/img/${file}.png`, url: `${CDN.poseDepth}/img/${file}.png` });
        }
      }
    }
  }

  if (wants("costume")) {
    const costumes = await readJson("costumes.json");
    for (const item of costumes.assets) {
      tasks.push({ rel: `costume/thumbs/${item.id}.webp`, url: `${CDN.costume}/thumbs/${item.id}.webp` });
      if (WITH_FULL) {
        tasks.push({ rel: `costume/img/${item.id}.webp`, url: `${CDN.costume}/img/${item.id}.webp` });
        tasks.push({ rel: `costume-full/png/${item.id}.png`, url: `${CDN.costumeFull}/png/${item.id}.png` });
      }
    }
    // 画风切换的动漫画风：索引里是绝对地址，按 pathname 镜像。
    const animeRows = await fetchJson(`${INDEX_BASE}/costume-anime/data/costume-zh.json`).catch(() => []);
    for (const row of animeRows) {
      for (const url of [row.缩略图, WITH_FULL ? row.预览图 : ""]) {
        if (!url) continue;
        const rel = relFromUrl("costume-anime", url);
        if (rel) tasks.push({ rel, url });
      }
    }
  }

  if (wants("portrait")) {
    const portraits = await readJson("portraits.json");
    for (const item of portraits.assets) {
      tasks.push({ rel: `portrait/img/thumb/${item.id}.webp`, url: `${CDN.portrait}/img/thumb/${item.id}.webp` });
      if (WITH_FULL) tasks.push({ rel: `portrait/img/full/${item.id}.png`, url: `${CDN.portrait}/img/full/${item.id}.png` });
    }
  }

  if (wants("anime")) {
    const rows = await fetchJson(`${INDEX_BASE}/anime/data/anime-zh.json`);
    for (const row of rows) {
      for (const url of [row.缩略图, WITH_FULL ? row.原图 : "", row.线稿]) {
        if (!url) continue;
        const rel = relFromUrl("anime", url);
        if (rel) tasks.push({ rel, url });
      }
    }
  }

  // 去重：同一张图可能被多个索引引用（发色变体会共享父级缩略图）。
  return [...new Map(tasks.map((task) => [task.rel, task])).values()];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(task) {
  const dest = path.join(OUT_DIR, task.rel);
  if (!FORCE && existsSync(dest) && statSync(dest).size > 0) return "skip";

  let reason = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(task.url, { headers: { "user-agent": "infinite-canvas-preset-fetch/1.0" } });
      const type = res.headers.get("content-type") || "";
      // CDN 对不存在的图会回 200 + 首页 HTML，只校验状态码会把整页灌进本地。
      if (!res.ok || !type.startsWith("image/")) throw new Error(`${res.status} ${type.split(";")[0]}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new Error("空响应");
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      return "ok";
    } catch (error) {
      reason = error.message;
      await sleep(400 * (attempt + 1));
    }
  }
  return { fail: true, reason };
}

/** 以磁盘实际内容为准重写清单：中途中断也能用已经拉下来的那部分。 */
function writeManifest() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name !== "manifest.json" && statSync(path.join(dir, entry.name)).size > 0) files.push(rel);
    }
  };
  walk(OUT_DIR, "");
  files.sort();
  writeFileSync(MANIFEST, `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 0)}\n`);
  return files.length;
}

const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

async function main() {
  console.log(`▶ 构建清单（${ONLY.join(" / ")}${WITH_FULL ? "" : "，仅缩略图"}）…`);
  const tasks = await buildTasks();
  console.log(`  共 ${tasks.length} 个文件待获取`);

  if (DRY_RUN) {
    for (const task of tasks.slice(0, 10)) console.log(`  ${task.rel}  ←  ${task.url}`);
    console.log(`  …（示例 10 条）`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  let index = 0;
  let ok = 0;
  let skip = 0;
  /** @type {{ rel: string, reason: string }[]} */
  const failed = [];
  const startedAt = Date.now();

  const worker = async () => {
    while (index < tasks.length) {
      const task = tasks[index];
      index += 1;
      const result = await download(task);
      if (result === "ok") ok += 1;
      else if (result === "skip") skip += 1;
      else failed.push({ rel: task.rel, reason: result.reason });

      const done = ok + skip + failed.length;
      if (done % 200 === 0 || done === tasks.length) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        console.log(`  ${done}/${tasks.length}  新增 ${ok}  跳过 ${skip}  失败 ${failed.length}  ${seconds}s`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const total = writeManifest();
  const bytes = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((sum, entry) => sum + dirSize(path.join(OUT_DIR, entry.name)), 0);

  console.log(`\n✔ 本地镜像完成：磁盘 ${total} 个文件 / ${formatMb(bytes)}，清单已写入 web/public/system-presets/manifest.json`);
  if (failed.length) {
    console.log(`\n✖ ${failed.length} 个文件取不到（多为上游缺图，前端会回落 CDN）：`);
    for (const item of failed.slice(0, 20)) console.log(`  ${item.rel}  ${item.reason}`);
    if (failed.length > 20) console.log(`  … 另有 ${failed.length - 20} 个`);
  }
}

function dirSize(dir) {
  let sum = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    sum += entry.isDirectory() ? dirSize(target) : statSync(target).size;
  }
  return sum;
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
});
