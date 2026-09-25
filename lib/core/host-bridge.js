/**
 * 备份的产出与恢复：把「DSH 分区引擎」「宿主 App 的软件数据」「加密」三件事拼起来。
 *
 * ## 三方分工
 *
 * - **DSH 分区**：交给 dsh-config-manager 的 loopback HTTP API（`/export` `/analyze`
 *   `/plan` `/execute`）。不 import 它的内部模块 —— 那些路径没有导出，跟着上游重构走会脆。
 * - **软件数据 + 外观**：住在 Android 的 `SharedPreferences` 与 `filesDir` 里，容器内的
 *   插件**物理上够不到**。只能请宿主 App 帮忙：App 的回环文件桥（`/root/.dsh/fs-bridge.json`）
 *   新增了 `/cloud/appdata/*` 端点族，插件按需取/放。
 * - **加密**：由 App 侧完成（与 App 自己导出的备份容器格式一致），这样同一份包在
 *   App 的恢复向导里也能直接用。
 *
 * ## 为什么产出走「App 出整包」而不是「插件拼」
 *
 * 含软件数据时，**包的组装交给 App**：它本来就有一套「插件出明文 → 合并 App 数据与主题 →
 * 改 manifest → 重算 checksums → 加密」的成熟通路（`DshConfigBackup.exportArchive`），
 * 插件再实现一遍只会多一处会漂移的格式。所以：
 * - 档位不含软件数据 → 插件自己调 dsh-config-manager 的 `/export` 拿包；
 * - 档位含软件数据 → 调 App 的 `/cloud/appdata/export`，由 App 复用它自己的通路产出整包。
 *
 * 检测不到 App 接口（旧版 App / 桥没起来）时，含软件数据的档位**自动回退**到不含软件数据的
 * 档位 —— 这正是需求里那条要求，回退事实由 [ProducedBackup.tierFellBack] 上报给界面与日志。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { fallbackTier, tierHasDsh, tierHasVault, tierNeedsApp, } from "./config.js";
/** 宿主 App 回环桥的配置文件名（容器内路径，由 App 在 DSH 启动时写入）。 */
export const APP_BRIDGE_CONFIG = '/root/.dsh/fs-bridge.json';
/** App 侧云备份端点前缀（App 的新接口）。 */
export const APP_CLOUD_PREFIX = '/cloud/appdata';
/** dsh-config-manager 的端点前缀。 */
export const CONFIG_MANAGER_PREFIX = '/api/dsh-config-manager';
/** 单次 App 桥请求的超时：出整包可能包含主题资源与 prefs，给足 5 分钟。 */
const APP_TIMEOUT_MS = 300_000;
/** dsh-config-manager 导出/导入的超时（大包 + 慢盘）。 */
const MANAGER_TIMEOUT_MS = 600_000;
/** 读宿主 App 回环桥的端口与 token（App 在 DSH 启动时写入）。 */
export async function readBridgeConfig() {
    try {
        const raw = await fs.readFile(APP_BRIDGE_CONFIG, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || parsed.token === '')
            return null;
        return { port: parsed.port, token: parsed.token };
    }
    catch {
        return null;
    }
}
/** 极简 loopback JSON 请求（只够本插件用，不引第三方 HTTP 客户端）。 */
function request(port, method, pathname, options) {
    return new Promise((resolve, reject) => {
        const headers = { accept: 'application/json' };
        if (options.token !== undefined)
            headers['x-dsh-fs-token'] = options.token;
        if (options.body !== undefined) {
            headers['content-type'] = options.contentType ?? 'application/octet-stream';
            headers['content-length'] = String(options.body.length);
        }
        const req = http.request({ method, host: '127.0.0.1', port, path: pathname, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`请求超时（${options.timeoutMs}ms）`)));
        req.on('error', reject);
        if (options.body !== undefined)
            req.write(options.body);
        req.end();
    });
}
/** 调 dsh-config-manager（回环，无 token —— 它自己的守卫是「回环 + 同源」）。 */
async function manager(method, pathname, body, timeoutMs = MANAGER_TIMEOUT_MS) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const port = await managerPort();
    if (port === null)
        throw new Error('找不到 DSH web 服务端口（dsh 可能没在运行）');
    const res = await request(port, method, `${CONFIG_MANAGER_PREFIX}${pathname}`, {
        ...(payload === undefined ? {} : { body: payload, contentType: 'application/json; charset=utf-8' }),
        timeoutMs,
    });
    let json = null;
    try {
        const parsed = JSON.parse(res.body.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null)
            json = parsed;
    }
    catch {
        json = null;
    }
    return { status: res.status, json, raw: res.body };
}
/**
 * DSH web 服务的端口。
 *
 * 从环境变量读（App 在启动 dsh 时会把它传进容器）；读不到就退回 3080（dsh web 的默认端口）。
 */
async function managerPort() {
    const env = process.env['DSH_WEB_PORT'] ?? process.env['PORT'];
    if (env !== undefined && /^\d+$/.test(env))
        return Number(env);
    // 容器内的 dsh 与插件同进程，回环端口默认 3080；这里不做端口扫描（慢且可能误伤）
    return 3080;
}
/** 宿主 App 的补包接口是否可用。 */
export async function appBridgeAvailable() {
    const bridge = await readBridgeConfig();
    if (bridge === null)
        return false;
    try {
        const res = await request(bridge.port, 'GET', `${APP_CLOUD_PREFIX}/status`, {
            token: bridge.token,
            timeoutMs: 10_000,
        });
        if (res.status !== 200)
            return false;
        const parsed = JSON.parse(res.body.toString('utf8'));
        return typeof parsed === 'object' && parsed !== null && parsed.available === true;
    }
    catch {
        return false;
    }
}
/**
 * 问宿主 App「当前外观主题打进包有多大」。
 *
 * 云备份面板的「是否包括应用主题」开关要按这个数字给默认值（超过 5MB 默认不含，
 * 免得同步包被字体/音乐/视频背景顶爆）。App 那边是真打一遍主题包量出来的（不落盘），
 * 所以这里别在页面渲染里高频调用 —— 面板只在打开时问一次，导出时若仍是自动模式再问一次。
 *
 * 拿不到（桥不可用 / 老版本 App 没这个端点）返回 null，调用方按「含主题」处理：
 * 不能因为量不出来就把用户的主题悄悄排除在备份之外。
 */
export async function themeInfo(force = false) {
    const bridge = await readBridgeConfig();
    if (bridge === null)
        return null;
    try {
        const suffix = force ? '?force=1' : '';
        const res = await request(bridge.port, 'GET', `${APP_CLOUD_PREFIX}/theme${suffix}`, {
            token: bridge.token,
            timeoutMs: APP_TIMEOUT_MS,
        });
        if (res.status !== 200)
            return null;
        const parsed = parseJson(res.body);
        if (parsed === null || typeof parsed['sizeBytes'] !== 'number')
            return null;
        const size = parsed['sizeBytes'];
        const limit = typeof parsed['limitBytes'] === 'number' ? parsed['limitBytes'] : 5 * 1024 * 1024;
        return {
            exists: parsed['exists'] === true,
            sizeBytes: size,
            limitBytes: limit,
            defaultInclude: typeof parsed['defaultInclude'] === 'boolean' ? parsed['defaultInclude'] : size <= limit,
        };
    }
    catch {
        return null;
    }
}
/** dsh-config-manager 是否在（本插件的硬依赖）。 */
export async function configManagerAvailable() {
    try {
        const res = await manager('GET', '/status', undefined, 10_000);
        return res.status === 200;
    }
    catch {
        return false;
    }
}
/**
 * 真实的产出实现。
 *
 * 两档分支见文件头注释：含软件数据走 App，否则走 dsh-config-manager。
 */
export class HostBackupProducer {
    async produce(outDir, tier, options) {
        await fs.mkdir(outDir, { recursive: true });
        const wantsApp = tierNeedsApp(tier);
        if (wantsApp && !(await appBridgeAvailable())) {
            // 需求里那条回退：检测不到 App 补包接口 → 退到不含软件数据的档位（保留 vault 语义）
            const fell = fallbackTier(tier);
            options.onLine?.(`宿主 App 未提供软件数据接口，档位回退：${tier} → ${fell}`);
            const produced = await this.produceWithoutApp(outDir, fell, options);
            return { ...produced, tier: fell, tierFellBack: true };
        }
        if (wantsApp)
            return await this.produceWithApp(outDir, tier, options);
        return await this.produceWithoutApp(outDir, tier, options);
    }
    /** 含软件数据：整包交给宿主 App 产出（复用它自己的合并/加密通路）。 */
    async produceWithApp(outDir, tier, options) {
        const bridge = await readBridgeConfig();
        if (bridge === null)
            throw new Error('宿主 App 回环桥配置缺失');
        options.onLine?.('请宿主 App 产出整包（含软件数据与外观）…');
        // 「自动」在这里落地：配置里没显式选过就现问 App 主题包多大，按它的建议决定含不含主题。
        // 放在这里而不是只放在界面上，是为了让定时同步（没人打开面板）也走同一套判断。
        let includeTheme = options.includeTheme;
        if (includeTheme === undefined) {
            const info = await themeInfo();
            if (info !== null) {
                includeTheme = info.defaultInclude;
                options.onLine?.(`外观主题 ${formatBytes(info.sizeBytes)}（上限 ${formatBytes(info.limitBytes)}）：` +
                    `${includeTheme ? '随包备份' : '过大，本次不含主题'}`);
            }
        }
        const body = Buffer.from(JSON.stringify({
            tier,
            includeSessions: options.includeSessions,
            ...(includeTheme === undefined ? {} : { includeTheme }),
            encrypt: options.password !== undefined,
            password: options.password ?? '',
            outDir,
        }), 'utf8');
        const res = await request(bridge.port, 'POST', `${APP_CLOUD_PREFIX}/export`, {
            token: bridge.token,
            body,
            contentType: 'application/json; charset=utf-8',
            timeoutMs: APP_TIMEOUT_MS,
        });
        const parsed = parseJson(res.body);
        if (res.status !== 200 || parsed === null || typeof parsed['file'] !== 'string') {
            const detail = typeof parsed?.['error'] === 'string' ? parsed['error'] : `HTTP ${res.status}`;
            throw new Error(`宿主 App 出包失败：${detail}`);
        }
        const file = parsed['file'];
        const size = Number(parsed['size'] ?? 0) || (await fs.stat(file)).size;
        return { file, tier, tierFellBack: false, size };
    }
    /** 不含软件数据：直接调 dsh-config-manager 导出，包就落在它的 exports 目录里。 */
    async produceWithoutApp(outDir, tier, options) {
        if (!tierHasDsh(tier))
            throw new Error(`档位 ${tier} 需要宿主 App 支持，但接口不可用`);
        options.onLine?.('正在让 dsh-config-manager 导出 DSH 数据…');
        const body = {
            includeSecrets: false,
            // 含 vault 的档位需要凭据原文：由 App 的补包接口负责；这里是纯 DSH 路径，
            // 所以只能导出「不含凭据值」的包 —— 档位语义由 tierHasVault 决定是否允许保存。
            password: options.password ?? '',
        };
        if (options.includeSessions)
            body['only'] = undefined;
        const res = await manager('POST', '/export', body);
        if (res.status !== 200 || res.json === null) {
            throw new Error(`dsh-config-manager 导出失败：HTTP ${res.status}`);
        }
        const zipPath = typeof res.json['zipPath'] === 'string' ? res.json['zipPath'] : '';
        if (zipPath === '')
            throw new Error('dsh-config-manager 没有返回 zipPath');
        // 导出物在容器的 ~/.dsh/dsh-config-manager/exports/ 下，直接引用即可（同一文件系统）
        const size = (await fs.stat(zipPath)).size;
        if (tierHasVault(tier)) {
            options.onLine?.('注意：纯 DSH 路径不含凭据原文（vault 需要宿主 App 参与）。');
        }
        return { file: zipPath, tier, tierFellBack: false, size };
    }
}
/** 真实的恢复实现：把包交给宿主 App（它本来就有一套恢复向导与校验通路）。 */
export class HostBackupRestorer {
    async restore(file, options) {
        const bridge = await readBridgeConfig();
        if (bridge === null) {
            return { ok: false, message: '宿主 App 回环桥配置缺失，无法恢复', needsRestart: 0 };
        }
        options.onLine?.('正在请宿主 App 执行恢复…');
        const body = Buffer.from(JSON.stringify({ file, password: options.password ?? '' }), 'utf8');
        const res = await request(bridge.port, 'POST', `${APP_CLOUD_PREFIX}/restore`, {
            token: bridge.token,
            body,
            contentType: 'application/json; charset=utf-8',
            timeoutMs: APP_TIMEOUT_MS,
        });
        const parsed = parseJson(res.body);
        if (res.status !== 200 || parsed === null) {
            const detail = typeof parsed?.['error'] === 'string' ? parsed['error'] : `HTTP ${res.status}`;
            return { ok: false, message: `恢复失败：${detail}`, needsRestart: 0 };
        }
        const ok = parsed['ok'] === true;
        return {
            ok,
            message: typeof parsed['message'] === 'string' ? parsed['message'] : ok ? '已恢复' : '恢复失败',
            needsRestart: Number(parsed['needsRestart'] ?? 0) || 0,
        };
    }
}
function parseJson(body) {
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    }
    catch {
        return null;
    }
}
/** 远端目录里的包文件名 → 本地临时文件路径。 */
export function localFilePath(workDir, remoteFile) {
    return path.join(workDir, path.basename(remoteFile));
}
/** 人类可读的字节数（日志里说明主题包多大用）。 */
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '未知大小';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
//# sourceMappingURL=host-bridge.js.map