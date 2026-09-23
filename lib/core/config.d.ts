/** 配置文件与历史文件都放在插件数据目录下（`$DSH_HOME/dsh-folk-cloud/`）。 */
export declare const CLOUD_DIR_NAME = "dsh-folk-cloud";
export declare const CONFIG_FILE = "cloud-config.json";
export declare const HISTORY_FILE = "cloud-history.json";
/** 本机事务历史保留条数（纯审计用途，超出的丢弃最旧的）。 */
export declare const MAX_COMMITS = 100;
/** WebDAV 口令的 DSH credentials 引用名（POSIX 环境变量形态，满足 CredentialRef 品牌要求）。 */
export declare const WEBDAV_CREDENTIAL_REF = "DSH_FOLK_CLOUD_WEBDAV_PASSWORD";
/**
 * 备份**加密口令**的 DSH credentials 引用名（与 WebDAV 口令分开存一份）。
 *
 * 与 WebDAV 口令同一条铁律：永不落盘、永不入日志、界面永不回读。持久化它是为了让**自动**
 * 触发（定时 / 启动后）也能加密——否则 `encrypt:true` 只能靠手动触发临时传口令，自动触发
 * 会拿不到口令而静默产出明文包（本插件已改为此时明确报错，不再静默）。
 */
export declare const ENCRYPT_CREDENTIAL_REF = "DSH_FOLK_CLOUD_ENCRYPT_PASSWORD";
/** 配置 schema 版本；读到更旧的版本时用默认值补齐（不猜测，缺什么用什么）。 */
export declare const CONFIG_SCHEMA_VERSION = 1;
/**
 * 备份档位。
 *
 * - [DSH_ONLY] / [DSH_VAULT] 由本插件独办：调 dsh-config-manager 的导出/导入引擎，
 *   本插件只负责把产物搬到 WebDAV。
 * - [APP_ONLY] / [APP_DSH] / [APP_DSH_VAULT] 需要宿主 App 的补包接口
 *   （App 设置与外观住在 Android 的 SharedPreferences 与 filesDir 里，容器内的插件
 *   **物理上够不到**，只能请 App 帮忙打包）。
 *
 * 档位与 DSH-Folk App 现有的四档对齐，并新增 DSH_VAULT（只 DSH 数据、含 vault）。
 */
export type BackupTier = 'dsh-only' | 'dsh-vault' | 'app-only' | 'app-dsh' | 'app-dsh-vault';
export declare const BACKUP_TIERS: readonly BackupTier[];
/** 该档位是否需要宿主 App 的补包接口。 */
export declare function tierNeedsApp(tier: BackupTier): boolean;
/** 该档位是否含凭据原文（导出时必须提供加密口令）。 */
export declare function tierHasVault(tier: BackupTier): boolean;
/** 该档位是否含 DSH 分区。 */
export declare function tierHasDsh(tier: BackupTier): boolean;
/**
 * 补包接口不可用时，该档位退到哪一档。
 *
 * 对应需求里的「插件备份档位设置后未检测到该接口则自动回退到不含软件数据的档位」：
 * 含 App 数据的档位一律退到只含 DSH 的那一档，且**保留 vault 语义**（含 vault 的退到
 * 含 vault 的），否则会在用户不知情的情况下把凭据原文从包里丢掉。
 */
export declare function fallbackTier(tier: BackupTier): BackupTier;
/** 触发方式。注意：**没有**「对话回合结束」—— DSH 插件面没有该事件（见 README）。 */
export interface TriggerConfig {
    /** 定时触发间隔（分钟）。0 = 关闭定时触发。 */
    intervalMinutes: number;
    /** DSH 启动后是否跑一次。 */
    onStartup: boolean;
    /** 手动触发永远可用，这里只是把这个事实显式记下来（界面据此显示）。 */
    manual: boolean;
}
export declare const DEFAULT_TRIGGER: TriggerConfig;
export interface CloudConfig {
    schemaVersion: number;
    /** WebDAV 根地址（不含凭据；拒绝 userinfo）。 */
    url: string;
    /** 可选用户名（非敏感，可回显）。 */
    username: string;
    /** 本次是否提供了新口令；`undefined` = 保持已存口令不变。**永不来自文件读取**。 */
    password?: string;
    /** 远端子目录（相对 url）。默认 `dsh-folk`，与 dsh-config-manager 的 `dsh-config-manager/` 并列。 */
    remoteDir: string;
    tier: BackupTier;
    /** 导出时是否带上会话分区（会显著变大）。 */
    includeSessions: boolean;
    /** 是否加密导出包。 */
    encrypt: boolean;
    /** 本次是否提供了新的**加密口令**；`undefined` = 保持已存的不变。**永不来自文件读取**。 */
    encryptPassword?: string;
    trigger: TriggerConfig;
}
export declare const DEFAULT_CONFIG: CloudConfig;
/** 远端 manifest 里的一条提交记录。 */
export interface Commit {
    /** 内容哈希（整包 zip 的 SHA-256，十六进制小写）。 */
    hash: string;
    /** 上传时间（ISO 8601）。 */
    at: string;
    /** 远端文件名（相对 [CloudConfig.remoteDir]）。 */
    file: string;
    /** 字节数（0 = 未知）。 */
    size: number;
    /** 产出该提交的档位。 */
    tier: BackupTier;
    /** 产出该提交的机器标识（同机多次备份可区分；不入隐私信息）。 */
    device: string;
}
/** 远端 manifest（`<remoteDir>/index.json`）。这就是「上游提交历史」。 */
export interface RemoteManifest {
    schemaVersion: number;
    /** 最新提交的 hash；空串 = 远端还没有任何备份。 */
    head: string;
    /** 提交列表，**时间倒序**（最新的在最前）。 */
    commits: Commit[];
}
export declare const MANIFEST_SCHEMA_VERSION = 1;
export declare function emptyManifest(): RemoteManifest;
/** 本机侧状态：上次同步的锚点 + 本机事务历史。 */
export interface CloudState {
    schemaVersion: number;
    /** 上次成功与上游对齐的 hash（上传或拉取之后写）。空 = 从未同步。 */
    lastSyncedHash: string;
    /** 上次本机算出的内容 hash（用来判断「本地也变了」）。 */
    lastLocalHash: string;
    /** 本机事务历史（时间倒序）。 */
    history: Commit[];
}
export declare function emptyState(): CloudState;
/** 校验 WebDAV 地址：http(s)、无空白、不含 userinfo。 */
export declare function validateWebdavUrl(url: string): string | null;
/** 远端子目录规范化：去掉首尾斜杠，拒绝 `..`（防写到别人的目录去）。 */
export declare function normalizeRemoteDir(dir: string): string;
/**
 * 把界面提交的原始对象合并成一份合法配置。
 *
 * 只接受已知字段，未知字段一律丢弃（界面传来的东西不能直接进文件）。
 * [password] 缺席 = 不改已存口令；传入空串与传 undefined 同义（空串无法与「不改」区分）。
 */
export declare function mergeConfig(raw: Record<string, unknown>, base: CloudConfig): CloudConfig;
/** 落盘前剥掉内存态字段（`password` / `encryptPassword` 绝不能进文件）。 */
export declare function configForDisk(cfg: CloudConfig): Omit<CloudConfig, 'password' | 'encryptPassword'>;
export declare function readConfig(dir: string): Promise<CloudConfig | null>;
export declare function writeConfig(dir: string, cfg: CloudConfig): Promise<void>;
export declare function readState(dir: string): Promise<CloudState>;
export declare function writeState(dir: string, state: CloudState): Promise<void>;
/** 把一条提交并进 manifest（同 hash 覆盖，时间倒序，上限 [MAX_COMMITS]）。 */
export declare function mergeCommit(manifest: RemoteManifest, commit: Commit): RemoteManifest;
