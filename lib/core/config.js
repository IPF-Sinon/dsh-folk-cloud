/**
 * 云备份的持久化配置与提交历史。
 *
 * ## 为什么配置文件里没有口令
 *
 * WebDAV 口令走 DSH credentials（引用名 [WEBDAV_CREDENTIAL_REF]），**永不落盘、永不入日志**。
 * 这与 dsh-config-manager 的 sync 配置同一条铁律：配置里只留 url 与非敏感的 username。
 *
 * ## 「密码留空 = 保持原密码」
 *
 * 界面回填时口令字段永远是空的（凭据系统不提供读回途径），保存时若该字段为空就**不动**
 * 已有的口令。这条行为由 [mergeConfig] 用 `password: undefined` 表达：undefined = 不改，
 * 空串从不出现（空串在 JSON 里与「不改」无法区分，所以干脆不允许它作为输入）。
 *
 * ## 提交历史
 *
 * `commits` 只记**本机见过并同步过的**上游提交（时间倒序，上限 [MAX_COMMITS]），
 * `lastSyncedHash` 是判定「上游有没有更新」「本地有没有改过」的锚点。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
/** 配置文件与历史文件都放在插件数据目录下（`$DSH_HOME/dsh-folk-cloud/`）。 */
export const CLOUD_DIR_NAME = 'dsh-folk-cloud';
export const CONFIG_FILE = 'cloud-config.json';
export const HISTORY_FILE = 'cloud-history.json';
/** 本机事务历史保留条数（纯审计用途，超出的丢弃最旧的）。 */
export const MAX_COMMITS = 100;
/** WebDAV 口令的 DSH credentials 引用名（POSIX 环境变量形态，满足 CredentialRef 品牌要求）。 */
export const WEBDAV_CREDENTIAL_REF = 'DSH_FOLK_CLOUD_WEBDAV_PASSWORD';
/**
 * 备份**加密口令**的 DSH credentials 引用名（与 WebDAV 口令分开存一份）。
 *
 * 与 WebDAV 口令同一条铁律：永不落盘、永不入日志、界面永不回读。持久化它是为了让**自动**
 * 触发（定时 / 启动后）也能加密——否则 `encrypt:true` 只能靠手动触发临时传口令，自动触发
 * 会拿不到口令而静默产出明文包（本插件已改为此时明确报错，不再静默）。
 */
export const ENCRYPT_CREDENTIAL_REF = 'DSH_FOLK_CLOUD_ENCRYPT_PASSWORD';
/** 配置 schema 版本；读到更旧的版本时用默认值补齐（不猜测，缺什么用什么）。 */
export const CONFIG_SCHEMA_VERSION = 1;
export const BACKUP_TIERS = [
    'dsh-only',
    'dsh-vault',
    'app-only',
    'app-dsh',
    'app-dsh-vault',
];
/** 该档位是否需要宿主 App 的补包接口。 */
export function tierNeedsApp(tier) {
    return tier === 'app-only' || tier === 'app-dsh' || tier === 'app-dsh-vault';
}
/** 该档位是否含凭据原文（导出时必须提供加密口令）。 */
export function tierHasVault(tier) {
    return tier === 'dsh-vault' || tier === 'app-dsh-vault';
}
/** 该档位是否含 DSH 分区。 */
export function tierHasDsh(tier) {
    return tier !== 'app-only';
}
/**
 * 补包接口不可用时，该档位退到哪一档。
 *
 * 对应需求里的「插件备份档位设置后未检测到该接口则自动回退到不含软件数据的档位」：
 * 含 App 数据的档位一律退到只含 DSH 的那一档，且**保留 vault 语义**（含 vault 的退到
 * 含 vault 的），否则会在用户不知情的情况下把凭据原文从包里丢掉。
 */
export function fallbackTier(tier) {
    if (!tierNeedsApp(tier))
        return tier;
    return tierHasVault(tier) ? 'dsh-vault' : 'dsh-only';
}
export const DEFAULT_TRIGGER = {
    intervalMinutes: 60,
    onStartup: true,
    manual: true,
};
export const DEFAULT_CONFIG = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    url: '',
    username: '',
    remoteDir: 'dsh-folk',
    tier: 'app-dsh',
    includeSessions: false,
    encrypt: true,
    trigger: { ...DEFAULT_TRIGGER },
};
export const MANIFEST_SCHEMA_VERSION = 1;
export function emptyManifest() {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, head: '', commits: [] };
}
export function emptyState() {
    return { schemaVersion: CONFIG_SCHEMA_VERSION, lastSyncedHash: '', lastLocalHash: '', history: [] };
}
/** 校验 WebDAV 地址：http(s)、无空白、不含 userinfo。 */
export function validateWebdavUrl(url) {
    const cleaned = url.trim();
    if (cleaned === '')
        return 'url is required';
    if (/\s/.test(cleaned))
        return 'url 不能包含空白字符';
    if (!/^https?:\/\//i.test(cleaned))
        return 'url 必须以 http:// 或 https:// 开头';
    let parsed;
    try {
        parsed = new URL(cleaned);
    }
    catch {
        return 'url 无法解析';
    }
    if (parsed.username !== '' || parsed.password !== '') {
        // 口令必须走凭据系统，不能写进 URL（会进日志/历史/备份）
        return 'url 不能包含账号密码（请填在用户名/密码栏）';
    }
    return null;
}
/** 远端子目录规范化：去掉首尾斜杠，拒绝 `..`（防写到别人的目录去）。 */
export function normalizeRemoteDir(dir) {
    const segs = dir
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== '.');
    if (segs.some((s) => s === '..'))
        throw new Error('远端子目录不能包含 ..');
    return segs.join('/');
}
function isTier(value) {
    return typeof value === 'string' && BACKUP_TIERS.includes(value);
}
/**
 * 把界面提交的原始对象合并成一份合法配置。
 *
 * 只接受已知字段，未知字段一律丢弃（界面传来的东西不能直接进文件）。
 * [password] 缺席 = 不改已存口令；传入空串与传 undefined 同义（空串无法与「不改」区分）。
 */
export function mergeConfig(raw, base) {
    const url = typeof raw['url'] === 'string' ? raw['url'].trim() : base.url;
    const username = typeof raw['username'] === 'string' ? raw['username'] : base.username;
    const remoteDirRaw = typeof raw['remoteDir'] === 'string' ? raw['remoteDir'] : base.remoteDir;
    const tierRaw = raw['tier'];
    const includeSessions = typeof raw['includeSessions'] === 'boolean' ? raw['includeSessions'] : base.includeSessions;
    const encrypt = typeof raw['encrypt'] === 'boolean' ? raw['encrypt'] : base.encrypt;
    const includeTheme = typeof raw['includeTheme'] === 'boolean' ? raw['includeTheme'] : base.includeTheme;
    let trigger = base.trigger;
    const rawTrigger = raw['trigger'];
    if (typeof rawTrigger === 'object' && rawTrigger !== null) {
        const t = rawTrigger;
        const minutes = typeof t['intervalMinutes'] === 'number' ? t['intervalMinutes'] : base.trigger.intervalMinutes;
        trigger = {
            // 负数与 NaN 会让定时器变成忙循环，统一夹到合法区间
            intervalMinutes: Number.isFinite(minutes) ? Math.min(Math.max(Math.trunc(minutes), 0), 24 * 60) : base.trigger.intervalMinutes,
            onStartup: typeof t['onStartup'] === 'boolean' ? t['onStartup'] : base.trigger.onStartup,
            manual: true,
        };
    }
    const password = typeof raw['password'] === 'string' && raw['password'] !== '' ? raw['password'] : undefined;
    const encryptPassword = typeof raw['encryptPassword'] === 'string' && raw['encryptPassword'] !== '' ? raw['encryptPassword'] : undefined;
    return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        url,
        username,
        ...(password === undefined ? {} : { password }),
        remoteDir: normalizeRemoteDir(remoteDirRaw),
        tier: isTier(tierRaw) ? tierRaw : base.tier,
        includeSessions,
        ...(includeTheme === undefined ? {} : { includeTheme }),
        encrypt,
        ...(encryptPassword === undefined ? {} : { encryptPassword }),
        trigger,
    };
}
/** 落盘前剥掉内存态字段（`password` / `encryptPassword` 绝不能进文件）。 */
export function configForDisk(cfg) {
    const { password: _pw, encryptPassword: _epw, ...rest } = cfg;
    return rest;
}
export async function readConfig(dir) {
    const file = path.join(dir, CONFIG_FILE);
    let text;
    try {
        text = await fs.readFile(file, 'utf8');
    }
    catch {
        return null;
    }
    const parsed = JSON.parse(text);
    // 文件里的东西一律当不可信输入处理：走同一个 mergeConfig，缺字段用默认值补齐。
    return mergeConfig(parsed, DEFAULT_CONFIG);
}
export async function writeConfig(dir, cfg) {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, CONFIG_FILE);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(configForDisk(cfg), null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
}
export async function readState(dir) {
    const file = path.join(dir, HISTORY_FILE);
    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        return {
            schemaVersion: CONFIG_SCHEMA_VERSION,
            lastSyncedHash: typeof parsed.lastSyncedHash === 'string' ? parsed.lastSyncedHash : '',
            lastLocalHash: typeof parsed.lastLocalHash === 'string' ? parsed.lastLocalHash : '',
            history: Array.isArray(parsed.history) ? parsed.history.filter(isCommit) : [],
        };
    }
    catch {
        return emptyState();
    }
}
export async function writeState(dir, state) {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, HISTORY_FILE);
    const tmp = `${file}.tmp`;
    const trimmed = { ...state, history: state.history.slice(0, MAX_COMMITS) };
    await fs.writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
}
function isCommit(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const c = value;
    return typeof c['hash'] === 'string' && typeof c['file'] === 'string' && typeof c['at'] === 'string';
}
/** 把一条提交并进 manifest（同 hash 覆盖，时间倒序，上限 [MAX_COMMITS]）。 */
export function mergeCommit(manifest, commit) {
    const others = manifest.commits.filter((c) => c.hash !== commit.hash);
    const commits = [commit, ...others]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, MAX_COMMITS);
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, head: commits[0]?.hash ?? '', commits };
}
/** 从清单里删掉一个提交；head 自动落到剩下最新的一条（没有则空）。 */
export function removeCommit(manifest, hash) {
    const commits = manifest.commits
        .filter((c) => c.hash !== hash)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, head: commits[0]?.hash ?? '', commits };
}
//# sourceMappingURL=config.js.map