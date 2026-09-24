import type { Context } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { type CloudConfig, type CloudState } from './core/config.ts';
import { type SyncReport } from './core/sync-engine.ts';
import { WebdavTransport } from './webdav/transport.ts';
/** 插件名：必须与 cordis.patch.yml 里的 row id 一致。 */
export declare const name = "folk-cloud";
/** 注入的服务：settings 用于数据目录定位，credentials 存 WebDAV 口令。 */
export declare const inject: string[];
/** 一次同步的运行状态（供 /status 与 /trigger 轮询）。 */
interface RunState {
    running: boolean;
    startedAt: string;
    finishedAt: string;
    lastReport: SyncReport | null;
    /** 当前阶段（进度弹窗画步骤用）。 */
    phase: string;
    /** 传输阶段的已传/总字节（进度条用；非传输阶段为 0）。 */
    uploaded: number;
    total: number;
    /** 本轮实时日志（弹窗流式显示；封顶行数，旧的丢掉）。 */
    lines: string[];
}
/**
 * 插件数据目录：`$DSH_HOME/dsh-folk-cloud/`。
 *
 * 与 dsh-config-manager 的数据目录**并列**（不塞进它里面：两个插件各自拥有自己的状态，
 * 混在一起会让「卸掉一个插件」变成一件需要小心的事）。
 */
export declare function resolveDataDir(): string;
/** 插件运行时：把配置/状态/传输/引擎串起来，路由与定时器都通过它工作。 */
declare class CloudRuntime {
    readonly dataDir: string;
    /** 同步互斥：一次只跑一轮（定时器与手动触发可能撞在一起）。 */
    private running;
    private run;
    private timer;
    private readonly credentials;
    private readonly log;
    constructor(credentials: CredentialProvider, log: (line: string) => void);
    config(): Promise<CloudConfig>;
    state(): Promise<CloudState>;
    private passwordProvider;
    /** 按当前配置造一个传输器；未配置地址时抛错（调用方回 400）。 */
    transport(cfg?: CloudConfig): Promise<WebdavTransport>;
    get runState(): RunState;
    /** 本轮开跑：重置阶段/进度/日志缓冲，标记 running。 */
    private beginRun;
    /** 一行实时日志：进 run.lines（封顶）+ 转给宿主 logger。 */
    private emitLine;
    /** 阶段/字节进度回调（喂给 sync-engine 的 onProgress）。 */
    private onProgress;
    /** 收尾：把本轮 run 标记为结束并记下报告（保留已累计的日志/进度）。 */
    private finishRun;
    /** 保存配置：校验地址、写口令到凭据、落盘（口令不进文件）。 */
    saveConfig(raw: Record<string, unknown>): Promise<CloudConfig>;
    /** WebDAV 口令是否已配置（只回布尔，永不回值）。 */
    passwordConfigured(): Promise<boolean>;
    /** 备份加密口令是否已配置（只回布尔，永不回值）。 */
    encryptPasswordConfigured(): Promise<boolean>;
    /** 已存的加密口令（读不到回空串）。仅供触发时内部取用，绝不外泄。 */
    private storedEncryptPassword;
    /**
     * 解析本轮要用的加密口令。
     *
     * 次序：界面本次显式传入的 [override] 优先（手动执行时可临时覆盖），否则用已存的加密口令。
     * 若该档位**要求加密**（[CloudConfig.encrypt] 或含 vault）却拿不到任何口令，则抛错——
     * 宁可明确失败，也绝不静默产出明文包（这正是自动触发以前的隐患）。
     */
    private resolveEncryptPassword;
    /** 配置状态视图：给界面回填用，绝不含口令值。 */
    status(): Promise<Record<string, unknown>>;
    /** 触发一轮同步。`mode` = auto / push / pull。 */
    trigger(mode: 'auto' | 'push' | 'pull', password?: string): Promise<SyncReport>;
    /** 冲突裁决：`keep` = local 用本机覆盖上游，remote 用上游覆盖本机。 */
    resolve(keep: 'local' | 'remote', password?: string): Promise<SyncReport>;
    /** 恢复一个指定的历史版本（用上游那一版覆盖本机，锚点对齐到这一版）。 */
    restoreCommit(hash: string, password?: string): Promise<SyncReport>;
    /** 从云端永久删除一个历史版本（删 WebDAV 文件 + 摘清单）。 */
    deleteCommit(hash: string): Promise<SyncReport>;
    /** 列出上游提交（只读，不写任何东西）。 */
    remoteCommits(): Promise<{
        ok: boolean;
        manifest: unknown;
        error?: string;
    }>;
    /** 探活（界面「测试连接」）。 */
    test(url: string, username: string, password: string): Promise<void>;
    /** 忘记上游锚点（下次同步会重新判断，不删远端任何东西）。 */
    forget(): Promise<CloudState>;
    /** 按配置重设定时器（启动时与每次保存配置后调用）。 */
    reschedule(cfg: CloudConfig): void;
    dispose(): void;
}
/**
 * 插件入口。
 *
 * 不依赖 webServer 也能活：没有 web 部署时路由跳过，但定时触发与手动（若有其他调用面）
 * 仍然可用 —— 与 dsh-config-manager 的处理方式一致。
 */
export declare function apply(ctx: Context, config?: {
    dataDir?: string;
}): void;
/** 全部路由。守卫口径：回环 + 同源（口令与备份都从这里过，不能对局域网开放）。 */
export declare function makeRoutes(runtime: CloudRuntime): WebRoute[];
/** 供测试导入（内部类型不对外）。 */
export type { RunState };
