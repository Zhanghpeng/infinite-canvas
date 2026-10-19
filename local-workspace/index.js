// Infinite Canvas 本地工作区服务。
//
// 只做一件事：把用户选定的工作区目录，通过一组受控的文件读写 API 暴露给前端。
// 安全模型与 canvas-agent 一致：仅监听 127.0.0.1 + token 校验 + Origin 白名单 + 路径不越界。
//
// 用法：
//   node index.js [--workspace <dir>]
//
// 配置默认落在 ~/.infinite-canvas/local-workspace.json，首次启动自动生成。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express from "express";

const DEFAULT_PORT = 17400;
const DEFAULT_HOST = "127.0.0.1";
const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
const CONFIG_FILE = path.join(CONFIG_DIR, "local-workspace.json");
const DEFAULT_WORKSPACE = path.join(os.homedir(), "InfiniteCanvasWorkspace");
const WORKSPACE_MANIFEST = "workspace.json";
const WORKSPACE_APP = "infinite-canvas";
const WORKSPACE_VERSION = 1;

// 工作区基础目录结构。projects/ 与 library/ 由使用方按需填充。
const BASE_DIRS = ["projects", "assets", "assets/images", "assets/media", ".meta", ".meta/cache", ".meta/logs", ".meta/backups"];

function loadConfig(options) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        config = { port: DEFAULT_PORT, host: DEFAULT_HOST, token: crypto.randomBytes(18).toString("hex"), workspacePath: DEFAULT_WORKSPACE, origins: [] };
        saveConfig(config);
    }
    if (!config.token) config.token = crypto.randomBytes(18).toString("hex");
    if (!config.workspacePath) config.workspacePath = DEFAULT_WORKSPACE;
    if (!config.host) config.host = DEFAULT_HOST;
    if (!Array.isArray(config.origins)) config.origins = [];
    if (options.host) config.host = options.host;
    if (options.workspace) config.workspacePath = path.resolve(options.workspace);
    if (options.host || options.workspace) saveConfig(config);
    return config;
}

function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(CONFIG_FILE, 0o600);
}

function parseArgs(argv) {
    const options = {};
    const workspaceIndex = argv.indexOf("--workspace");
    if (workspaceIndex >= 0 && argv[workspaceIndex + 1]) options.workspace = argv[workspaceIndex + 1];
    const hostIndex = argv.indexOf("--host");
    if (hostIndex >= 0 && argv[hostIndex + 1]) options.host = argv[hostIndex + 1];
    return options;
}

function workspaceRoot(config) {
    return path.resolve(config.workspacePath);
}

// 把请求里的相对路径解析为工作区内的绝对路径，任何越界尝试都拒绝。
function resolveInside(root, relative = "") {
    const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(root, normalized);
    const boundary = root.endsWith(path.sep) ? root : root + path.sep;
    if (target !== root && !target.startsWith(boundary)) {
        const error = new Error("path escapes workspace root");
        error.status = 400;
        throw error;
    }
    return target;
}

function readManifest(root) {
    const file = path.join(root, WORKSPACE_MANIFEST);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.app !== WORKSPACE_APP) {
        const error = new Error("not an infinite-canvas workspace");
        error.status = 409;
        throw error;
    }
    return data;
}

function initWorkspace(root) {
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    BASE_DIRS.forEach((dir) => fs.mkdirSync(path.join(root, dir), { recursive: true }));
    const now = new Date().toISOString();
    const existing = fs.existsSync(path.join(root, WORKSPACE_MANIFEST)) ? JSON.parse(fs.readFileSync(path.join(root, WORKSPACE_MANIFEST), "utf8")) : null;
    const manifest = {
        app: WORKSPACE_APP,
        version: WORKSPACE_VERSION,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        name: existing?.name || path.basename(root),
        projects: Array.isArray(existing?.projects) ? existing.projects : [],
    };
    fs.writeFileSync(path.join(root, WORKSPACE_MANIFEST), JSON.stringify(manifest, null, 2));
    return manifest;
}

function updateManifest(root, patch) {
    const current = readManifest(root) || initWorkspace(root);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(root, WORKSPACE_MANIFEST), JSON.stringify(next, null, 2));
    return next;
}

async function listEntries(dir, recursive = false) {
    const entries = [];
    const walk = async (current, prefix) => {
        const dirents = await fs.promises.readdir(current, { withFileTypes: true });
        for (const dirent of dirents) {
            const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
            if (dirent.isDirectory()) {
                if (recursive) await walk(path.join(current, dirent.name), rel);
                else entries.push({ path: rel, type: "directory" });
            } else {
                const stat = await fs.promises.stat(path.join(current, dirent.name));
                entries.push({ path: rel, type: "file", size: stat.size, mtime: stat.mtimeMs });
            }
        }
    };
    await walk(dir, "");
    return entries;
}

function createApp(config) {
    const app = express();
    const root = workspaceRoot(config);

    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        res.setHeader("Access-Control-Allow-Headers", "content-type,x-workspace-token");
        res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
        // 目录列表与文件内容都是随时会变的动态数据，必须禁止缓存——
        // 否则浏览器（以及测试环境的 fetch 实现）会复用上一次 GET /files 的旧结果。
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        if (!origin || req.path === "/health") return next();
        if (config.origins.includes(origin)) return next();
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            config.origins.push(origin);
            saveConfig(config);
            return next();
        }
        return res.status(403).json({ error: "origin not allowed" });
    });

    app.use((req, res, next) => {
        if (req.path === "/health") return next();
        const token = req.headers["x-workspace-token"] || req.query.token;
        if (token !== config.token) return res.status(401).json({ error: "invalid token" });
        next();
    });

    // 注意：json 中间件只能挂在「请求体确实是 JSON」的路由上。
    // 不能全局 app.use(express.json())——它会预先消费掉 PUT /file 的请求体，
    // 而前端写 JSON 内容时用的正是 application/json 类型的 Blob，那样落盘会变成 0 字节。
    const jsonBody = express.json({ limit: "1mb" });

    app.get("/health", (_req, res) => res.json({ ok: true, workspacePath: root }));

    app.get("/workspace", (_req, res) => {
        try {
            const manifest = readManifest(root);
            res.json({ ok: true, workspacePath: root, manifest });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    app.post("/workspace/init", jsonBody, (req, res) => {
        try {
            const target = req.body?.path ? path.resolve(String(req.body.path)) : root;
            const manifest = initWorkspace(target);
            res.json({ ok: true, workspacePath: target, manifest });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    app.get("/files", async (req, res) => {
        try {
            const dir = resolveInside(root, req.query.dir || "");
            if (!fs.existsSync(dir)) return res.json({ ok: true, entries: [] });
            const entries = await listEntries(dir, req.query.recursive === "true");
            res.json({ ok: true, entries });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    app.get("/file", (req, res) => {
        try {
            const file = resolveInside(root, req.query.path);
            if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).json({ error: "file not found" });
            res.setHeader("Content-Type", "application/octet-stream");
            fs.createReadStream(file).pipe(res);
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    // 直接以请求体作为文件内容流式落盘，不经过 body 解析，避免大文件受 JSON 体积限制。
    app.put("/file", async (req, res) => {
        try {
            const file = resolveInside(root, req.query.path);
            if (!req.query.path) return res.status(400).json({ error: "path required" });
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await pipeline(req, fs.createWriteStream(file));
            const stat = await fs.promises.stat(file);
            res.json({ ok: true, path: req.query.path, size: stat.size });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    app.delete("/file", async (req, res) => {
        try {
            const file = resolveInside(root, req.query.path);
            if (!req.query.path) return res.status(400).json({ error: "path required" });
            await fs.promises.rm(file, { recursive: true, force: true });
            res.json({ ok: true });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    app.post("/file/rename", jsonBody, async (req, res) => {
        try {
            const { from, to } = req.body || {};
            if (!from || !to) return res.status(400).json({ error: "from and to required" });
            const source = resolveInside(root, from);
            const target = resolveInside(root, to);
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.rename(source, target);
            res.json({ ok: true });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message });
        }
    });

    return app;
}

const options = parseArgs(process.argv.slice(2));
const config = loadConfig(options);
initWorkspace(workspaceRoot(config));

const app = createApp(config);
const port = Number(process.env.PORT) || config.port || DEFAULT_PORT;
const host = process.env.HOST || config.host || DEFAULT_HOST;

app.listen(port, host, () => {
    console.log(`Local workspace URL: http://${host === "0.0.0.0" ? "<本机地址>" : host}:${port}`);
    console.log(`Workspace path: ${workspaceRoot(config)}`);
    console.log(`Connect token: ${config.token}`);
});
