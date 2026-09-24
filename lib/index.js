/**
 * dsh-folk-cloud —— DSH-Folk 的 WebDAV 云备份插件（宿主半）。
 *
 * ## 这个插件解决什么
 *
 * DSH-Folk 之前的云备份是 App 自己做的（okhttp + 手写 PROPFIND），只能整包上传/下载，
 * 没有增量、没有上游历史、也没有「上游被别人更新了」这个概念。本插件把这件事搬进 DSH：
 * 按触发器拉上游 manifest 判断更新，用**内容哈希**去重，冲突时停下让用户决定。
 *
 * ## 依赖关系
 *
 * 硬依赖 dsh-config-manager：DSH 分区的读写引擎（`/export` `/analyze` `/plan` `/execute`）
 * 全在它那里，本插件不重复实现，只用它的 loopback HTTP API（不 import 内部模块 ——
 * 那些路径没有导出，跟着上游重构走会脆）。
 *
 * 软依赖宿主 App 的补包接口：软件数据（Android prefs + 外观）只有 App 够得着。
 * 接口不可用时，含软件数据的档位自动回退到不含软件数据的档位，并如实上报。
 *
 * ## 触发器
 *
 * 三种：定时（N 分钟）、DSH 启动后、手动（HTTP 接口）。
 * **没有**「每轮对话结束」—— DSH 的插件面没有对话回合事件（本插件不 inject llm/tools，
 * 也没有可用的 turn/message hook），与其做一个不可靠的近似，不如不做。
 */
import path from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { CLOUD_DIR_NAME, DEFAULT_CONFIG, WEBDAV_CREDENTIAL_REF, ENCRYPT_CREDENTIAL_REF, configForDisk, mergeConfig, readConfig, readState, tierHasVault, tierNeedsApp, validateWebdavUrl, writeConfig, writeState, } from "./core/config.js";
import { isLoopbackRequest, readJsonBody, writeJson } from "./core/http.js";
import { HostBackupProducer, HostBackupRestorer, appBridgeAvailable, configManagerAvailable, } from "./core/host-bridge.js";
import { resolveConflict, restoreCommit, runSync } from "./core/sync-engine.js";
import { readRemoteManifest } from "./core/store.js";
import { WebdavError, WebdavTransport } from "./webdav/transport.js";
/** 插件名：必须与 cordis.patch.yml 里的 row id 一致。 */
export const name = 'folk-cloud';
/** 注入的服务：settings 用于数据目录定位，credentials 存 WebDAV 口令。 */
export const inject = ['settings', 'credentials'];
/** 路由前缀。 */
const API = {
    status: '/api/dsh-folk-cloud/status',
    config: '/api/dsh-folk-cloud/config',
    test: '/api/dsh-folk-cloud/test',
    trigger: '/api/dsh-folk-cloud/trigger',
    resolve: '/api/dsh-folk-cloud/resolve',
    restore: '/api/dsh-folk-cloud/restore',
    forget: '/api/dsh-folk-cloud/forget',
};
/** 定时触发的最短间隔：小于 1 分钟等于忙循环。 */
const MIN_INTERVAL_MINUTES = 1;
/** 凭据引用的品牌化。 */
const WEBDAV_REF = credentialRef(WEBDAV_CREDENTIAL_REF);
const ENCRYPT_REF = credentialRef(ENCRYPT_CREDENTIAL_REF);
/**
 * 插件数据目录：`$DSH_HOME/dsh-folk-cloud/`。
 *
 * 与 dsh-config-manager 的数据目录**并列**（不塞进它里面：两个插件各自拥有自己的状态，
 * 混在一起会让「卸掉一个插件」变成一件需要小心的事）。
 */
export function resolveDataDir() {
    const home = process.env['DSH_HOME'] ?? path.join(process.env['HOME'] ?? '/root', '.dsh');
    return path.join(home, CLOUD_DIR_NAME);
}
/** 口令提供者：每次请求现取（凭据改了立刻生效），绝不缓存进配置。 */
class CredentialPassword {
    credentials;
    constructor(credentials) {
        this.credentials = credentials;
    }
    async getPassword() {
        const resolved = await this.credentials.resolve(WEBDAV_REF);
        return resolved?.value ?? '';
    }
}
/** 插件运行时：把配置/状态/传输/引擎串起来，路由与定时器都通过它工作。 */
class CloudRuntime {
    dataDir = resolveDataDir();
    /** 同步互斥：一次只跑一轮（定时器与手动触发可能撞在一起）。 */
    running = false;
    run = { running: false, startedAt: '', finishedAt: '', lastReport: null };
    timer;
    credentials;
    log;
    constructor(credentials, log) {
        this.credentials = credentials;
        this.log = log;
    }
    async config() {
        return (await readConfig(this.dataDir)) ?? { ...DEFAULT_CONFIG };
    }
    async state() {
        return readState(this.dataDir);
    }
    passwordProvider() {
        return new CredentialPassword(this.credentials);
    }
    /** 按当前配置造一个传输器；未配置地址时抛错（调用方回 400）。 */
    async transport(cfg) {
        const config = cfg ?? (await this.config());
        const urlError = validateWebdavUrl(config.url);
        if (urlError !== null)
            throw new WebdavError(urlError);
        return new WebdavTransport({
            baseUrl: config.url,
            username: config.username,
            credentials: this.passwordProvider(),
        });
    }
    get runState() {
        return this.run;
    }
    /** 保存配置：校验地址、写口令到凭据、落盘（口令不进文件）。 */
    async saveConfig(raw) {
        const base = await this.config();
        const merged = mergeConfig(raw, base);
        const urlError = validateWebdavUrl(merged.url);
        if (urlError !== null)
            throw new WebdavError(urlError);
        // 含 vault 的档位必须能加密，否则凭据原文会被明文打包
        if (tierHasVault(merged.tier) && !merged.encrypt) {
            throw new WebdavError('含 vault 的档位必须开启加密（否则凭据会明文落盘）');
        }
        if (merged.password !== undefined) {
            // 「密码留空 = 保持原密码」由 mergeConfig 保证：空串不会走到这里
            await this.credentials.set(WEBDAV_REF, merged.password);
        }
        if (merged.encryptPassword !== undefined) {
            // 加密口令同理：空串不会走到这里（留空 = 不改已存的）
            await this.credentials.set(ENCRYPT_REF, merged.encryptPassword);
        }
        await writeConfig(this.dataDir, merged);
        this.reschedule(merged);
        return merged;
    }
    /** WebDAV 口令是否已配置（只回布尔，永不回值）。 */
    async passwordConfigured() {
        const info = await this.credentials.describe(WEBDAV_REF);
        return info.configured;
    }
    /** 备份加密口令是否已配置（只回布尔，永不回值）。 */
    async encryptPasswordConfigured() {
        const info = await this.credentials.describe(ENCRYPT_REF);
        return info.configured;
    }
    /** 已存的加密口令（读不到回空串）。仅供触发时内部取用，绝不外泄。 */
    async storedEncryptPassword() {
        const resolved = await this.credentials.resolve(ENCRYPT_REF);
        return resolved?.value ?? '';
    }
    /**
     * 解析本轮要用的加密口令。
     *
     * 次序：界面本次显式传入的 [override] 优先（手动执行时可临时覆盖），否则用已存的加密口令。
     * 若该档位**要求加密**（[CloudConfig.encrypt] 或含 vault）却拿不到任何口令，则抛错——
     * 宁可明确失败，也绝不静默产出明文包（这正是自动触发以前的隐患）。
     */
    async resolveEncryptPassword(cfg, override) {
        const explicit = override !== undefined && override !== '' ? override : '';
        const pw = explicit !== '' ? explicit : await this.storedEncryptPassword();
        const mustEncrypt = cfg.encrypt || tierHasVault(cfg.tier);
        if (mustEncrypt && pw === '') {
            throw new WebdavError('已开启加密但未设置备份加密口令：请先在「配置 WebDAV」里填写加密口令，或关闭加密。');
        }
        return pw;
    }
    /** 配置状态视图：给界面回填用，绝不含口令值。 */
    async status() {
        const cfg = await this.config();
        const state = await this.state();
        const [passwordConfigured, encryptPasswordConfigured, appAvailable, managerAvailable] = await Promise.all([
            this.passwordConfigured(),
            this.encryptPasswordConfigured(),
            appBridgeAvailable(),
            configManagerAvailable(),
        ]);
        // 档位是否被回退：含软件数据但 App 接口不在 → 实际会跑在不含软件数据的档位上
        const effectiveTier = tierNeedsApp(cfg.tier) && !appAvailable ? fallbackTierOf(cfg.tier) : cfg.tier;
        return {
            ok: true,
            configured: cfg.url !== '',
            url: cfg.url,
            username: cfg.username,
            passwordConfigured,
            encryptPasswordConfigured,
            remoteDir: cfg.remoteDir,
            tier: cfg.tier,
            effectiveTier,
            tierFellBack: effectiveTier !== cfg.tier,
            includeSessions: cfg.includeSessions,
            encrypt: cfg.encrypt,
            trigger: cfg.trigger,
            appBridgeAvailable: appAvailable,
            configManagerAvailable: managerAvailable,
            lastSyncedHash: state.lastSyncedHash,
            history: state.history,
            run: { running: this.run.running, startedAt: this.run.startedAt, finishedAt: this.run.finishedAt },
            lastReport: this.run.lastReport,
        };
    }
    /** 触发一轮同步。`mode` = auto / push / pull。 */
    async trigger(mode, password) {
        if (this.running) {
            return {
                outcome: 'error',
                message: '已经有一轮同步在跑，请稍后再试。',
                localHash: '',
                remoteHash: '',
                file: '',
                tierFellBackTo: '',
                conflict: null,
                lines: [],
            };
        }
        this.running = true;
        this.run = { running: true, startedAt: new Date().toISOString(), finishedAt: '', lastReport: null };
        try {
            const cfg = await this.config();
            const state = await this.state();
            // 加密口令：本次显式传入优先，否则用已存的；要加密却没口令则明确报错（不静默出明文包）。
            const encryptPw = await this.resolveEncryptPassword(cfg, password);
            const transport = await this.transport(cfg);
            const result = await runSync({
                transport,
                producer: new HostBackupProducer(),
                restorer: new HostBackupRestorer(),
                config: cfg,
                state,
                workDir: this.dataDir,
                mode,
                ...(encryptPw === '' ? {} : { password: encryptPw }),
                onLine: (line) => this.log(line),
            });
            await writeState(this.dataDir, result.state);
            this.run = {
                running: false,
                startedAt: this.run.startedAt,
                finishedAt: new Date().toISOString(),
                lastReport: result.report,
            };
            return result.report;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const report = {
                outcome: 'error',
                message,
                localHash: '',
                remoteHash: '',
                file: '',
                tierFellBackTo: '',
                conflict: null,
                lines: [message],
            };
            this.run = { running: false, startedAt: this.run.startedAt, finishedAt: new Date().toISOString(), lastReport: report };
            return report;
        }
        finally {
            this.running = false;
        }
    }
    /** 冲突裁决：`keep` = local 用本机覆盖上游，remote 用上游覆盖本机。 */
    async resolve(keep, password) {
        this.running = true;
        this.run = { running: true, startedAt: new Date().toISOString(), finishedAt: '', lastReport: null };
        try {
            const cfg = await this.config();
            const state = await this.state();
            const encryptPw = await this.resolveEncryptPassword(cfg, password);
            const transport = await this.transport(cfg);
            const result = await resolveConflict({
                transport,
                producer: new HostBackupProducer(),
                restorer: new HostBackupRestorer(),
                config: cfg,
                state,
                workDir: this.dataDir,
                keep,
                ...(encryptPw === '' ? {} : { password: encryptPw }),
                onLine: (line) => this.log(line),
            });
            await writeState(this.dataDir, result.state);
            this.run = {
                running: false,
                startedAt: this.run.startedAt,
                finishedAt: new Date().toISOString(),
                lastReport: result.report,
            };
            return result.report;
        }
        finally {
            this.running = false;
        }
    }
    /** 恢复一个指定的历史版本（用上游那一版覆盖本机，锚点对齐到这一版）。 */
    async restoreCommit(hash, password) {
        if (this.running) {
            return {
                outcome: 'error',
                message: '已经有一轮同步在跑，请稍后再试。',
                localHash: '',
                remoteHash: '',
                file: '',
                tierFellBackTo: '',
                conflict: null,
                lines: [],
            };
        }
        this.running = true;
        this.run = { running: true, startedAt: new Date().toISOString(), finishedAt: '', lastReport: null };
        try {
            const cfg = await this.config();
            const state = await this.state();
            const encryptPw = await this.resolveEncryptPassword(cfg, password);
            const transport = await this.transport(cfg);
            const result = await restoreCommit({
                transport,
                producer: new HostBackupProducer(),
                restorer: new HostBackupRestorer(),
                config: cfg,
                state,
                workDir: this.dataDir,
                targetHash: hash,
                ...(encryptPw === '' ? {} : { password: encryptPw }),
                onLine: (line) => this.log(line),
            });
            await writeState(this.dataDir, result.state);
            this.run = {
                running: false,
                startedAt: this.run.startedAt,
                finishedAt: new Date().toISOString(),
                lastReport: result.report,
            };
            return result.report;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const report = {
                outcome: 'error',
                message,
                localHash: '',
                remoteHash: '',
                file: '',
                tierFellBackTo: '',
                conflict: null,
                lines: [message],
            };
            this.run = { running: false, startedAt: this.run.startedAt, finishedAt: new Date().toISOString(), lastReport: report };
            return report;
        }
        finally {
            this.running = false;
        }
    }
    /** 列出上游提交（只读，不写任何东西）。 */
    async remoteCommits() {
        try {
            const cfg = await this.config();
            const transport = await this.transport(cfg);
            const manifest = await readRemoteManifest(transport, cfg.remoteDir);
            return { ok: true, manifest };
        }
        catch (error) {
            return { ok: false, manifest: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** 探活（界面「测试连接」）。 */
    async test(url, username, password) {
        const urlError = validateWebdavUrl(url);
        if (urlError !== null)
            throw new WebdavError(urlError);
        const transport = new WebdavTransport({
            baseUrl: url,
            username,
            // 测试用「界面刚填的口令」；留空则退回已保存的
            credentials: password === ''
                ? this.passwordProvider()
                : { getPassword: async () => password },
        });
        await transport.test();
    }
    /** 忘记上游锚点（下次同步会重新判断，不删远端任何东西）。 */
    async forget() {
        const state = { ...(await this.state()), lastSyncedHash: '', lastLocalHash: '' };
        await writeState(this.dataDir, state);
        return state;
    }
    /** 按配置重设定时器（启动时与每次保存配置后调用）。 */
    reschedule(cfg) {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        const minutes = cfg.trigger.intervalMinutes;
        if (minutes < MIN_INTERVAL_MINUTES)
            return;
        this.timer = setInterval(() => {
            void this.trigger('auto');
        }, minutes * 60_000);
        // 定时器不应该拖住进程退出（dsh 停服时插件会 dispose）
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
    }
    dispose() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
}
/** 档位回退（与此处 config.ts 的 fallbackTier 同名但避免循环引用的重复实现）。 */
function fallbackTierOf(tier) {
    if (tier === 'app-dsh-vault')
        return 'dsh-vault';
    if (tier === 'app-dsh')
        return 'dsh-only';
    if (tier === 'app-only')
        return 'dsh-only';
    return tier;
}
/**
 * 插件入口。
 *
 * 不依赖 webServer 也能活：没有 web 部署时路由跳过，但定时触发与手动（若有其他调用面）
 * 仍然可用 —— 与 dsh-config-manager 的处理方式一致。
 */
export function apply(ctx, config) {
    const runtime = new CloudRuntime(ctx.credentials, (line) => {
        ctx.logger?.info?.(`[folk-cloud] ${line}`);
    });
    void config;
    // 用 ctx.effect：cordis 的 Disposable 注册方式（dsh-config-manager 同款）。
    // 直接 ctx.on('dispose', ...) 在这里类型不成立 —— Events 里没有 dispose 这个键。
    ctx.effect(() => () => runtime.dispose(), 'folk-cloud: timers');
    void (async () => {
        const cfg = await runtime.config();
        runtime.reschedule(cfg);
        // DSH 启动后触发一次（受配置开关约束）。延迟 20s：启动瞬间各项服务还没稳，
        // 立刻同步容易拿到「dsh-config-manager 还没就绪」的假失败。
        if (cfg.trigger.onStartup && cfg.url !== '') {
            setTimeout(() => {
                void runtime.trigger('auto');
            }, 20_000).unref?.();
        }
    })();
    // webServer 用 ctx.inject 的作用域注入，而不是直接读 ctx.webServer。
    //
    // 原因：cordis 的 Context 是代理，直接访问一个「未 inject 且此刻不在 store 里」的服务名会
    // **抛** `cannot get property "webServer" without inject`（不是返回 undefined）。webServer 由
    // 另一个插件注册，插件加载次序不保证它先于本插件就绪——直接读就可能在启动时炸掉整棵插件树
    // （真机 dsh web --port 0 验证即如此）。ctx.inject([...], cb) 会等这些服务到位才跑 cb、服务
    // 消失时自动 dispose；webServer 一直没有（非 web 部署）则 cb 不跑，路由跳过——正好是我们要的
    // 「可选」语义，且不再有时序竞态。
    ctx.inject(['webServer'], (ctx) => {
        const webServer = ctx.webServer;
        const routes = makeRoutes(runtime);
        const disposers = routes.map((route) => webServer.register(route));
        ctx.effect(() => () => {
            for (const dispose of disposers)
                dispose();
        }, 'folk-cloud: routes');
    });
}
/** 全部路由。守卫口径：回环 + 同源（口令与备份都从这里过，不能对局域网开放）。 */
export function makeRoutes(runtime) {
    const guard = (req, res, method) => {
        if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' });
            return false;
        }
        if (req.method !== method) {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` });
            return false;
        }
        return true;
    };
    return [
        {
            kind: 'exact',
            path: API.status,
            handler: async (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                try {
                    writeJson(res, 200, await runtime.status());
                }
                catch (error) {
                    writeJson(res, 500, { error: describe(error) });
                }
            },
        },
        {
            kind: 'exact',
            path: API.config,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const body = await readJsonBody(req);
                if (body === undefined) {
                    writeJson(res, 400, { error: 'invalid JSON body' });
                    return;
                }
                try {
                    const saved = await runtime.saveConfig(body);
                    writeJson(res, 200, {
                        ok: true,
                        // 回显不含口令：只回它配没配上（界面据此显示「已配置/未配置」）
                        url: saved.url,
                        username: saved.username,
                        remoteDir: saved.remoteDir,
                        tier: saved.tier,
                        includeSessions: saved.includeSessions,
                        encrypt: saved.encrypt,
                        trigger: saved.trigger,
                        passwordConfigured: await runtime.passwordConfigured(),
                        encryptPasswordConfigured: await runtime.encryptPasswordConfigured(),
                    });
                }
                catch (error) {
                    writeJson(res, error instanceof WebdavError ? 400 : 500, { error: describe(error) });
                }
            },
        },
        {
            kind: 'exact',
            path: API.test,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const body = await readJsonBody(req);
                if (body === undefined) {
                    writeJson(res, 400, { error: 'invalid JSON body' });
                    return;
                }
                try {
                    await runtime.test(typeof body['url'] === 'string' ? body['url'] : '', typeof body['username'] === 'string' ? body['username'] : '', typeof body['password'] === 'string' ? body['password'] : '');
                    writeJson(res, 200, { ok: true });
                }
                catch (error) {
                    writeJson(res, 400, { ok: false, error: describe(error) });
                }
            },
        },
        {
            kind: 'exact',
            path: API.trigger,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const body = await readJsonBody(req);
                const modeRaw = body?.['mode'];
                const mode = modeRaw === 'push' || modeRaw === 'pull' ? modeRaw : 'auto';
                const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;
                const report = await runtime.trigger(mode, password);
                writeJson(res, 200, report);
            },
        },
        {
            kind: 'exact',
            path: API.resolve,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const body = await readJsonBody(req);
                const keepRaw = body?.['keep'];
                if (keepRaw !== 'local' && keepRaw !== 'remote') {
                    writeJson(res, 400, { error: "keep 必须是 'local' 或 'remote'" });
                    return;
                }
                const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;
                writeJson(res, 200, await runtime.resolve(keepRaw, password));
            },
        },
        {
            kind: 'exact',
            path: API.restore,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const body = await readJsonBody(req);
                const hash = typeof body?.['hash'] === 'string' ? body['hash'] : '';
                if (hash === '') {
                    writeJson(res, 400, { error: 'hash 不能为空' });
                    return;
                }
                const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;
                writeJson(res, 200, await runtime.restoreCommit(hash, password));
            },
        },
        {
            kind: 'exact',
            path: API.forget,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                writeJson(res, 200, { ok: true, state: await runtime.forget() });
            },
        },
    ];
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=index.js.map