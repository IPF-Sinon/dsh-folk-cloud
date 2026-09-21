/**
 * 远端 manifest 的读写与本地缓存目录。
 *
 * manifest 就是需求里的「上游提交历史」：`<remoteDir>/index.json`，记录每次备份的
 * 时间 / 整包哈希 / 文件名 / 档位。云备份的「有没有更新」全靠它判定 —— 不是真 git，
 * 而是一个刻意做小的清单（一个 zip + 一个 json，任何 WebDAV 都能存）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION,
  emptyManifest,
  type Commit,
  type RemoteManifest,
} from './config.ts';
import type { WebdavTransport } from '../webdav/transport.ts';

/** manifest 在远端目录里的文件名。 */
export const MANIFEST_FILE = 'index.json';

/** 本地工作目录（下载下来的包、待上传的包都放这儿）。 */
export function localDir(dataDir: string): string {
  return dataDir;
}

export function localTmpDir(dataDir: string): string {
  return path.join(dataDir, 'tmp');
}

/** 远端备份文件名的前缀（便于用户在其他工具里一眼认出是本插件写的）。 */
export const REMOTE_PREFIX = 'folk-cloud-';

/** 由时间戳 + 哈希前 8 位生成远端文件名（带哈希便于人工核对，也天然避免撞名）。 */
export function remoteFileName(at: Date, hash: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${REMOTE_PREFIX}${stamp}-${hash.slice(0, 8)}.zip`;
}

/**
 * 读远端 manifest。
 *
 * 404 / 解析失败 / 结构不对都当作「远端还没有备份」——首次同步时远端必然是空的，
 * 把它当错误会让「第一次用」这条路直接走不通。**但网络与鉴权失败必须抛出**：
 * 那两种情况下把状态误判成「远端为空」，会导致本机把一份新备份推上去覆盖掉既有历史。
 */
export async function readRemoteManifest(transport: WebdavTransport, remoteDir: string): Promise<RemoteManifest> {
  const raw = await transport.get(joinRemote(remoteDir, MANIFEST_FILE));
  if (raw === null) return emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return emptyManifest();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyManifest();
  const m = parsed as Partial<RemoteManifest>;
  const commits = Array.isArray(m.commits) ? m.commits.filter(isCommitLike) : [];
  const sorted = [...commits].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    head: sorted[0]?.hash ?? '',
    commits: sorted,
  };
}

/** 写远端 manifest（先建目录，再覆盖写）。 */
export async function writeRemoteManifest(
  transport: WebdavTransport,
  remoteDir: string,
  manifest: RemoteManifest,
): Promise<void> {
  await transport.ensureDir(remoteDir);
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await transport.put(joinRemote(remoteDir, MANIFEST_FILE), body, 'application/json; charset=utf-8');
}

/** 远端路径拼接（remoteDir 已规范化，不含 ..）。 */
export function joinRemote(dir: string, file: string): string {
  return dir === '' ? file : `${dir}/${file}`;
}

function isCommitLike(value: unknown): value is Commit {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c['hash'] === 'string' &&
    typeof c['file'] === 'string' &&
    typeof c['at'] === 'string' &&
    c['hash'] !== '' &&
    c['file'] !== ''
  );
}

/** 确保本地工作目录存在，并清掉上次留下的临时文件。 */
export async function prepareLocalDir(dataDir: string): Promise<void> {
  const tmp = localTmpDir(dataDir);
  await fs.mkdir(tmp, { recursive: true });
  // tmp 里的东西都是「上次跑到一半留下的」：整包可能上百 MB，不清会一直堆积
  const entries = await fs.readdir(tmp).catch(() => [] as string[]);
  for (const name of entries) {
    await fs.rm(path.join(tmp, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 读一个本地文件并算 SHA-256（十六进制小写）。流式计算，避免把大包整个读进内存。 */
export async function sha256File(file: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}
