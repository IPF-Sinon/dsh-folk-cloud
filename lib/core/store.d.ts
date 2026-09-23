import { type RemoteManifest } from './config.ts';
import type { WebdavTransport } from '../webdav/transport.ts';
/** manifest 在远端目录里的文件名。 */
export declare const MANIFEST_FILE = "index.json";
/** 本地工作目录（下载下来的包、待上传的包都放这儿）。 */
export declare function localDir(dataDir: string): string;
export declare function localTmpDir(dataDir: string): string;
/** 远端备份文件名的前缀（便于用户在其他工具里一眼认出是本插件写的）。 */
export declare const REMOTE_PREFIX = "folk-cloud-";
/** 由时间戳 + 哈希前 8 位生成远端文件名（带哈希便于人工核对，也天然避免撞名）。 */
export declare function remoteFileName(at: Date, hash: string): string;
/**
 * 读远端 manifest。
 *
 * 404 / 解析失败 / 结构不对都当作「远端还没有备份」——首次同步时远端必然是空的，
 * 把它当错误会让「第一次用」这条路直接走不通。**但网络与鉴权失败必须抛出**：
 * 那两种情况下把状态误判成「远端为空」，会导致本机把一份新备份推上去覆盖掉既有历史。
 */
export declare function readRemoteManifest(transport: WebdavTransport, remoteDir: string): Promise<RemoteManifest>;
/** 写远端 manifest（先建目录，再覆盖写）。 */
export declare function writeRemoteManifest(transport: WebdavTransport, remoteDir: string, manifest: RemoteManifest): Promise<void>;
/** 远端路径拼接（remoteDir 已规范化，不含 ..）。 */
export declare function joinRemote(dir: string, file: string): string;
/** 确保本地工作目录存在，并清掉上次留下的临时文件。 */
export declare function prepareLocalDir(dataDir: string): Promise<void>;
/** 读一个本地文件并算 SHA-256（十六进制小写）。流式计算，避免把大包整个读进内存。 */
export declare function sha256File(file: string): Promise<string>;
