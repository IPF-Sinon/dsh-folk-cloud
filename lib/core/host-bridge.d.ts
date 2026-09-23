import { type BackupTier } from './config.ts';
import type { BackupProducer, BackupRestorer, ProduceOptions, RestoreOptions, RestoreReport, ProducedBackup } from './sync-engine.ts';
/** 宿主 App 回环桥的配置文件名（容器内路径，由 App 在 DSH 启动时写入）。 */
export declare const APP_BRIDGE_CONFIG = "/root/.dsh/fs-bridge.json";
/** App 侧云备份端点前缀（App 的新接口）。 */
export declare const APP_CLOUD_PREFIX = "/cloud/appdata";
/** dsh-config-manager 的端点前缀。 */
export declare const CONFIG_MANAGER_PREFIX = "/api/dsh-config-manager";
interface BridgeConfig {
    port: number;
    token: string;
}
/** 读宿主 App 回环桥的端口与 token（App 在 DSH 启动时写入）。 */
export declare function readBridgeConfig(): Promise<BridgeConfig | null>;
/** 宿主 App 的补包接口是否可用。 */
export declare function appBridgeAvailable(): Promise<boolean>;
/** dsh-config-manager 是否在（本插件的硬依赖）。 */
export declare function configManagerAvailable(): Promise<boolean>;
/**
 * 真实的产出实现。
 *
 * 两档分支见文件头注释：含软件数据走 App，否则走 dsh-config-manager。
 */
export declare class HostBackupProducer implements BackupProducer {
    produce(outDir: string, tier: BackupTier, options: ProduceOptions): Promise<ProducedBackup>;
    /** 含软件数据：整包交给宿主 App 产出（复用它自己的合并/加密通路）。 */
    private produceWithApp;
    /** 不含软件数据：直接调 dsh-config-manager 导出，包就落在它的 exports 目录里。 */
    private produceWithoutApp;
}
/** 真实的恢复实现：把包交给宿主 App（它本来就有一套恢复向导与校验通路）。 */
export declare class HostBackupRestorer implements BackupRestorer {
    restore(file: string, options: RestoreOptions): Promise<RestoreReport>;
}
/** 远端目录里的包文件名 → 本地临时文件路径。 */
export declare function localFilePath(workDir: string, remoteFile: string): string;
export {};
