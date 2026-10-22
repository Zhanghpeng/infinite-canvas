import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type WorkbuddyConfig = { accessToken?: string; baseUrl?: string };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig; workbuddy?: WorkbuddyConfig };

/** 读取 WorkBuddy 配置，支持环境变量优先覆盖。 */
export function getWorkbuddyConfig(config: CanvasAgentConfig): Required<WorkbuddyConfig> {
    return {
        accessToken: process.env.WORKBUDDY_ACCESS_TOKEN || config.workbuddy?.accessToken || "",
        baseUrl: (process.env.WORKBUDDY_BASE_URL || config.workbuddy?.baseUrl || "https://www.workbuddy.cn").replace(/\/+$/, ""),
    };
}

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    writeConfigFile(CONFIG_DIR, CONFIG_FILE, config);
}

/** 写入配置并强制目录 0700、文件 0600，包括纠正已有宽松权限。 */
export function writeConfigFile(dir: string, file: string, config: CanvasAgentConfig) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Infinite Canvas Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    syncBuiltinSkills(workspacePath);
    initializedWorkspaces.add(workspacePath);
}

/** 内置技能标记：有这个文件才说明目录归包管，可以安全覆盖。 */
type BuiltinSkillMarker = { version: string; sourceHash?: string; syncedAt: string };

/**
 * 把随包发布的内置技能铺到工作区 `.agents/skills/`，Codex 通过 `skills/list` 就能发现。
 *
 * 三条规矩：
 * - 只覆盖带 `.builtin.json` 标记的目录 —— 用户自己装的同名技能永不碰；
 * - 包版本与内容哈希都没变才跳过，避免每次启动都全量拷贝；
 * - 想定制内置技能，复制一份改名（见 builtin-skills/README.md），就地改会被升级覆盖。
 *
 * 光看包版本不够：开发期改 SKILL.md 而不升版本时，工作区会一直用旧的（而且看不出来）。
 * 所以标记里一并存内容哈希。
 */
function syncBuiltinSkills(workspacePath: string) {
    const source = fileURLToPath(new URL("../builtin-skills", import.meta.url));
    if (!fs.existsSync(source)) return;
    const target = path.join(workspacePath, ".agents", "skills");
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const from = path.join(source, entry.name);
        // 目录里有 SKILL.md 才算技能，README 之类的辅助文件跳过
        if (!fs.existsSync(path.join(from, "SKILL.md"))) continue;
        const to = path.join(target, entry.name);
        const marker = path.join(to, ".builtin.json");
        const installed = readBuiltinMarker(marker);
        // 同名目录存在但没标记 = 用户自己的技能，让给它
        if (fs.existsSync(to) && !installed) continue;
        const sourceHash = hashSkillDirectory(from);
        if (installed?.version === VERSION && installed.sourceHash === sourceHash) continue;
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
        const next: BuiltinSkillMarker = { version: VERSION, sourceHash, syncedAt: new Date().toISOString() };
        fs.writeFileSync(marker, JSON.stringify(next, null, 2));
    }
}

/** 技能目录内容哈希（相对路径 + 内容），用于判断要不要重新铺。 */
function hashSkillDirectory(dir: string): string {
    const hash = crypto.createHash("sha1");
    const walk = (current: string, prefix: string) => {
        const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name === ".builtin.json") continue;
            const full = path.join(current, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(full, rel);
                continue;
            }
            hash.update(rel);
            hash.update("\0");
            hash.update(fs.readFileSync(full));
            hash.update("\0");
        }
    };
    walk(dir, "");
    return hash.digest("hex");
}

/** 读取内置技能标记，损坏或缺失都当作"不是我们装的"。 */
function readBuiltinMarker(file: string): BuiltinSkillMarker | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BuiltinSkillMarker;
        return typeof parsed?.version === "string" ? parsed : null;
    } catch {
        return null;
    }
}


/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
