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
/** 主题包信息（宿主 App 量出来的真数）。量不出来返回 null。 */
export interface ThemeInfo {
    exists: boolean;
    sizeBytes: number;
    limitBytes: number;
    /** 宿主给的推荐默认值：超过 limit 就是 false。 */
    defaultInclude: boolean;
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
export declare function themeInfo(force?: boolean): Promise<ThemeInfo | null>;
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
