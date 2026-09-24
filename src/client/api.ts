/**
 * Client 半 —— `/api/dsh-folk-cloud/*` 的类型化 fetch 封装。
 *
 * 同源 fetch（dsh web 与这些路由同源），不 import 任何 node 模块（纯浏览器 bundle）。
 * 响应里的错误文本直接展示给用户：插件返回的已经是中文与原样状态码，翻译一遍只会失真。
 */

/** GET /status 的响应（口令只回布尔，永不回值）。 */
export interface CloudStatus {
  ok: boolean;
  configured: boolean;
  url: string;
  username: string;
  passwordConfigured: boolean;
  /** 备份加密口令是否已存（与 WebDAV 口令分开一份）。 */
  encryptPasswordConfigured: boolean;
  remoteDir: string;
  /** 用户设置的档位。 */
  tier: string;
  /** 实际会跑的档位（App 接口不可用时会被回退）。 */
  effectiveTier: string;
  tierFellBack: boolean;
  includeSessions: boolean;
  encrypt: boolean;
  trigger: { intervalMinutes: number; onStartup: boolean; manual: boolean };
  appBridgeAvailable: boolean;
  configManagerAvailable: boolean;
  lastSyncedHash: string;
  history: CloudCommit[];
  run: { running: boolean; startedAt: string; finishedAt: string };
  lastReport: SyncReport | null;
}

export interface CloudCommit {
  hash: string;
  at: string;
  file: string;
  size: number;
  tier: string;
  device: string;
}

export interface SyncReport {
  outcome: 'up-to-date' | 'uploaded' | 'skipped-identical' | 'restored' | 'conflict' | 'error';
  message: string;
  localHash: string;
  remoteHash: string;
  file: string;
  tierFellBackTo: string;
  conflict: {
    remoteHash: string;
    localHash: string;
    remoteCommit: CloudCommit | null;
    remoteAt: string;
  } | null;
  lines: string[];
}

/** 保存配置的载荷（password / encryptPassword 留空 = 保持已存的）。 */
export interface CloudConfigDraft {
  url: string;
  username: string;
  password?: string;
  remoteDir: string;
  tier: string;
  includeSessions: boolean;
  encrypt: boolean;
  /** 备份加密口令；留空/缺席 = 不改已存的。 */
  encryptPassword?: string;
  trigger: { intervalMinutes: number; onStartup: boolean };
}

interface ErrorBody {
  error?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const detail = (parsed as ErrorBody | null)?.error;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

export class CloudApi {
  async status(): Promise<CloudStatus> {
    return readJson<CloudStatus>(await fetch('/api/dsh-folk-cloud/status'));
  }

  async save(draft: CloudConfigDraft): Promise<CloudStatus> {
    return readJson<CloudStatus>(
      await fetch('/api/dsh-folk-cloud/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    );
  }

  /** 测试连接。`password` 留空则用已保存的口令。 */
  async test(url: string, username: string, password: string): Promise<void> {
    await readJson<{ ok: boolean }>(
      await fetch('/api/dsh-folk-cloud/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, username, password }),
      }),
    );
  }

  /** 立即执行一轮。mode: auto 按状态机决定推或拉；push/pull 强制单向。 */
  async trigger(mode: 'auto' | 'push' | 'pull', password?: string): Promise<SyncReport> {
    return readJson<SyncReport>(
      await fetch('/api/dsh-folk-cloud/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, ...(password === undefined ? {} : { password }) }),
      }),
    );
  }

  /** 冲突裁决：keep = local 用本机覆盖上游，remote 用上游覆盖本机。 */
  async resolve(keep: 'local' | 'remote', password?: string): Promise<SyncReport> {
    return readJson<SyncReport>(
      await fetch('/api/dsh-folk-cloud/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keep, ...(password === undefined ? {} : { password }) }),
      }),
    );
  }

  /** 恢复一个指定的历史版本（用那一版覆盖本机，锚点对齐到这一版）。 */
  async restore(hash: string, password?: string): Promise<SyncReport> {
    return readJson<SyncReport>(
      await fetch('/api/dsh-folk-cloud/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash, ...(password === undefined ? {} : { password }) }),
      }),
    );
  }

  /** 忘记上游锚点（不删远端任何东西）。 */
  async forget(): Promise<void> {
    await readJson<{ ok: boolean }>(await fetch('/api/dsh-folk-cloud/forget', { method: 'POST' }));
  }
}
