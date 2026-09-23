import { type BackupTier, type CloudConfig, type CloudState, type Commit, type RemoteManifest } from './config.ts';
import type { WebdavTransport } from '../webdav/transport.ts';
/** 产出一份备份包的结果。 */
export interface ProducedBackup {
    /** 本地文件路径（调用方负责清理）。 */
    file: string;
    /** 实际生效的档位（可能因 App 补包接口不可用而回退）。 */
    tier: BackupTier;
    /** 是否发生了档位回退（界面据此提示用户）。 */
    tierFellBack: boolean;
    /** 字节数。 */
    size: number;
}
/** 「出一份备份」的抽象。 */
export interface BackupProducer {
    /**
     * 出一份备份到 [outDir]。
     *
     * [tier] 是**用户设置**的档位；实现方若发现该档位所需的 App 补包接口不可用，必须自行
     * 回退到不含软件数据的档位，并在返回值里如实标记（见 [ProducedBackup.tierFellBack]）。
     */
    produce(outDir: string, tier: BackupTier, options: ProduceOptions): Promise<ProducedBackup>;
}
export interface ProduceOptions {
    includeSessions: boolean;
    /** 加密口令；`encrypt=false` 时为 undefined。 */
    password?: string;
    onLine?: (line: string) => void;
}
/** 「把一份备份恢复回本机」的抽象。 */
export interface BackupRestorer {
    restore(file: string, options: RestoreOptions): Promise<RestoreReport>;
}
export interface RestoreOptions {
    /** 解密口令（上游那份包若是加密的）。 */
    password?: string;
    onLine?: (line: string) => void;
}
export interface RestoreReport {
    ok: boolean;
    message: string;
    /** 需要重启 DSH 才生效的条目数。 */
    needsRestart: number;
}
export type SyncOutcome = 'up-to-date' | 'uploaded' | 'skipped-identical' | 'restored' | 'conflict' | 'error';
export interface SyncReport {
    outcome: SyncOutcome;
    message: string;
    /** 本地产出的哈希（未产出则空）。 */
    localHash: string;
    /** 远端 head（未知则空）。 */
    remoteHash: string;
    /** 上传/下载的文件名（无则空）。 */
    file: string;
    /** 档位回退时的实际档位（未回退为空）。 */
    tierFellBackTo: string;
    /** 冲突时的可选项（界面据此渲染裁决按钮）。 */
    conflict: ConflictInfo | null;
    lines: string[];
}
/** 冲突：本地与上游都变了，需要人工选择保留哪一边。 */
export interface ConflictInfo {
    remoteHash: string;
    localHash: string;
    remoteCommit: Commit | null;
    /** 远端提交的时间（便于用户判断哪边更新）。 */
    remoteAt: string;
}
export interface SyncDeps {
    transport: WebdavTransport;
    producer: BackupProducer;
    restorer: BackupRestorer;
    config: CloudConfig;
    state: CloudState;
    workDir: string;
    /** 'auto' = 按状态机决定推或拉；'push' 强制只上推；'pull' 强制只下取。 */
    mode: 'auto' | 'push' | 'pull';
    password?: string;
    onLine?: (line: string) => void;
}
export interface SyncResult {
    report: SyncReport;
    state: CloudState;
    manifest: RemoteManifest | null;
}
/** 跑一轮同步。所有外部副作用都经注入的接口发生，因此本函数可在 Node 里完整测试。 */
export declare function runSync(deps: SyncDeps): Promise<SyncResult>;
/** 冲突的人工裁决。[keep] = 'local' 用本机覆盖上游，'remote' 用上游覆盖本机。 */
export declare function resolveConflict(deps: Omit<SyncDeps, 'mode'> & {
    keep: 'local' | 'remote';
}): Promise<SyncResult>;
/** 本机标识：只用主机名前 8 位，不上报任何用户信息。 */
export declare function deviceTag(): string;
/** 把状态重置成「尚未同步」（用户在界面点「忘记上游」时用）。 */
export declare function resetState(): CloudState;
