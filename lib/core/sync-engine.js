/**
 * 同步引擎：判定「上游有没有更新 / 本地改没改过」，然后决定推、拉、还是停下报冲突。
 *
 * ## 状态机
 *
 * 三个哈希决定一切：
 * - `remote.head` —— 上游最新提交的内容哈希；
 * - `state.lastSyncedHash` —— 本机上次与上游对齐时的哈希（锚点）；
 * - `localHash` —— 本机此刻用同一套档位重出一份备份算出来的哈希。
 *
 * 判定顺序（顺序本身就是设计，别随手调换）：
 * 1. `mode=pull` → 直接拉取（用户明确要求，不再看本地改没改）；
 * 2. 上游与本机都没动 → 什么都不做（连本地包都删掉）；
 * 3. `localHash == remote.head` → 内容其实一样，跳过上传、把锚点对齐（**放在冲突判定之前**：
 *    内容相同不构成冲突，先报冲突会让用户白白做一次无意义的选择）；
 * 4. 上游与本机都动了 → **停下报冲突**，等人工裁决（不去猜谁优先）；
 * 5. 只有上游动 → 拉取并恢复；
 * 6. 只有本机动 → 上传并更新上游清单。
 *
 * `mode=push`（人工裁决「用本机」）会跳过 3–5 直接上传 —— 那是用户的明确决定。
 *
 * ## 为什么产出备份这一步要注入
 *
 * 「出一份备份」跨越三个世界：DSH 分区（dsh-config-manager 的导出引擎）、App 设置与外观
 * （Android 侧，只有宿主 App 够得着）、加密（本插件）。引擎因此只依赖 [BackupProducer] /
 * [BackupRestorer] 两个接口，真实实现见 `src/core/host-bridge.ts`；测试里换成假实现即可把
 * 这套判定逻辑完整穷举 —— 判错了的后果是覆盖用户的备份，所以它必须能被测。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyState, mergeCommit, } from "./config.js";
import { MANIFEST_FILE, joinRemote, prepareLocalDir, readRemoteManifest, remoteFileName, sha256File, writeRemoteManifest, } from "./store.js";
/** 跑一轮同步。所有外部副作用都经注入的接口发生，因此本函数可在 Node 里完整测试。 */
export async function runSync(deps) {
    const { transport, producer, config, workDir, mode } = deps;
    const lines = [];
    const say = (line) => {
        lines.push(line);
        deps.onLine?.(line);
    };
    const state = deps.state;
    const remoteDir = config.remoteDir;
    await prepareLocalDir(workDir);
    let manifest;
    try {
        manifest = await readRemoteManifest(transport, remoteDir);
    }
    catch (error) {
        return { report: errorReport(lines, `读取上游清单失败：${describe(error)}`), state, manifest: null };
    }
    const remoteHead = manifest.head;
    say(`上游最新提交：${remoteHead === '' ? '（还没有备份）' : remoteHead.slice(0, 12)}`);
    say(`上次同步锚点：${state.lastSyncedHash === '' ? '（从未同步）' : state.lastSyncedHash.slice(0, 12)}`);
    // ① 用户明确要求「用上游覆盖本机」：直接拉，不再看本地改没改
    if (mode === 'pull') {
        if (remoteHead === '') {
            return { report: idle('上游还没有备份，没有可恢复的内容', lines), state, manifest };
        }
        return await doPull({ deps, manifest, state, lines, say });
    }
    // ② 出一份本机备份（这一步同时给出 localHash）
    let produced;
    try {
        produced = await producer.produce(workDir, config.tier, {
            includeSessions: config.includeSessions,
            ...(config.encrypt && deps.password !== undefined ? { password: deps.password } : {}),
            ...(deps.onLine === undefined ? {} : { onLine: deps.onLine }),
        });
    }
    catch (error) {
        return { report: errorReport(lines, `本机备份失败：${describe(error)}`), state, manifest };
    }
    const localHash = await sha256File(produced.file);
    say(`本机备份：${path.basename(produced.file)}（${produced.size} 字节，${localHash.slice(0, 12)}）`);
    if (produced.tierFellBack) {
        say(`⚠ 档位已回退：${config.tier} → ${produced.tier}（宿主 App 未提供软件数据补包接口）`);
    }
    // ③ 用户明确要求「用本机覆盖上游」：直接上传
    if (mode === 'push') {
        return await doPush({ deps, manifest, state, produced, localHash, remoteHead, lines, say });
    }
    const remoteChanged = remoteHead !== '' && remoteHead !== state.lastSyncedHash;
    const localChanged = localHash !== state.lastSyncedHash;
    // ④ 上游与本机都没动 → 连上传都不用，把本地包删掉
    if (!remoteChanged && !localChanged) {
        await removeQuietly(produced.file);
        say('本机与上游一致，不上传。');
        return {
            report: {
                ...idle('已是最新，无需上传。', lines),
                localHash,
                remoteHash: remoteHead,
                tierFellBackTo: produced.tierFellBack ? produced.tier : '',
            },
            state,
            manifest,
        };
    }
    // ⑤ 内容与上游 head 完全相同 → 跳过上传，把锚点对齐。
    //    必须放在冲突判定之前：内容相同不构成冲突，先报冲突只是白让用户选一次。
    if (remoteHead !== '' && localHash === remoteHead) {
        await removeQuietly(produced.file);
        say('本机备份与上游已有提交内容相同，已删除本地包、不上传。');
        return {
            report: {
                outcome: 'skipped-identical',
                message: '内容与上游相同，已跳过上传。',
                localHash,
                remoteHash: remoteHead,
                file: '',
                tierFellBackTo: produced.tierFellBack ? produced.tier : '',
                conflict: null,
                lines,
            },
            state: { ...state, lastSyncedHash: localHash, lastLocalHash: localHash },
            manifest,
        };
    }
    // ⑥ 上游与本机都动了 → 冲突：停下，交给人工裁决
    if (remoteChanged && localChanged) {
        await removeQuietly(produced.file);
        const remoteCommit = manifest.commits.find((c) => c.hash === remoteHead) ?? null;
        say('上游与本机都有改动，已停下等待选择（不自动合并）。');
        return {
            report: {
                outcome: 'conflict',
                message: '上游与本机都有改动：请选择保留哪一边。',
                localHash,
                remoteHash: remoteHead,
                file: '',
                tierFellBackTo: produced.tierFellBack ? produced.tier : '',
                conflict: {
                    remoteHash: remoteHead,
                    localHash,
                    remoteCommit,
                    remoteAt: remoteCommit?.at ?? '',
                },
                lines,
            },
            state,
            manifest,
        };
    }
    // ⑦ 只有上游动了 → 拉取并恢复
    if (remoteChanged) {
        await removeQuietly(produced.file);
        return await doPull({ deps, manifest, state, lines, say });
    }
    // ⑧ 只有本机动了 → 上传
    return await doPush({ deps, manifest, state, produced, localHash, remoteHead, lines, say });
}
/** 上传：内容与上游 head 相同则丢弃本地包、不传（「相同则不上传并删除」）。 */
async function doPush(args) {
    const { deps, state, produced, localHash, lines, say } = args;
    const { transport, config } = deps;
    if (localHash === args.remoteHead) {
        await removeQuietly(produced.file);
        say('本机备份与上游已有提交内容相同，已删除本地包、不上传。');
        return {
            report: {
                outcome: 'skipped-identical',
                message: '内容与上游相同，已跳过上传。',
                localHash,
                remoteHash: args.remoteHead,
                file: '',
                tierFellBackTo: produced.tierFellBack ? produced.tier : '',
                conflict: null,
                lines,
            },
            state: { ...state, lastSyncedHash: localHash, lastLocalHash: localHash },
            manifest: args.manifest,
        };
    }
    const at = new Date();
    const file = remoteFileName(at, localHash);
    let body;
    try {
        body = await fs.readFile(produced.file);
        await transport.ensureDir(config.remoteDir);
        await transport.put(joinRemote(config.remoteDir, file), body);
    }
    catch (error) {
        await removeQuietly(produced.file);
        say(`上传失败：${describe(error)}`);
        return {
            report: errorReport(lines, `上传失败：${describe(error)}`),
            state,
            manifest: args.manifest,
        };
    }
    say(`已上传 ${file}（${body.length} 字节）`);
    const commit = {
        hash: localHash,
        at: at.toISOString(),
        file,
        size: body.length,
        tier: produced.tier,
        device: deviceTag(),
    };
    const manifest = mergeCommit(args.manifest, commit);
    try {
        await writeRemoteManifest(transport, config.remoteDir, manifest);
    }
    catch (error) {
        // 包传上去了但清单没更新：这是「半成功」，必须如实说 —— 否则用户以为同步好了，
        // 而下一轮会因为清单没变而重新上传同一份内容。
        await removeQuietly(produced.file);
        say(`已上传 ${file}，但更新上游清单失败：${describe(error)}`);
        return {
            report: errorReport(lines, `已上传但清单未更新：${describe(error)}`),
            state,
            manifest: args.manifest,
        };
    }
    say(`已更新上游清单（${MANIFEST_FILE}）`);
    await removeQuietly(produced.file);
    return {
        report: {
            outcome: 'uploaded',
            message: `已上传：${file}`,
            localHash,
            remoteHash: localHash,
            file,
            tierFellBackTo: produced.tierFellBack ? produced.tier : '',
            conflict: null,
            lines,
        },
        state: {
            ...state,
            lastSyncedHash: localHash,
            lastLocalHash: localHash,
            history: [commit, ...state.history.filter((c) => c.hash !== localHash)].slice(0, 100),
        },
        manifest,
    };
}
/** 拉取：下载上游 head 那一份，自校验后交给恢复实现。 */
async function doPull(args) {
    const { deps, manifest, state, say, lines } = args;
    const { transport, config, restorer } = deps;
    const head = manifest.head;
    const commit = manifest.commits.find((c) => c.hash === head);
    if (commit === undefined) {
        return { report: errorReport(lines, '上游清单里找不到最新提交对应的文件'), state, manifest };
    }
    const local = path.join(deps.workDir, commit.file);
    try {
        const body = await transport.get(joinRemote(config.remoteDir, commit.file));
        if (body === null) {
            return { report: errorReport(lines, `上游文件不存在：${commit.file}`), state, manifest };
        }
        await fs.mkdir(path.dirname(local), { recursive: true });
        await fs.writeFile(local, body);
        say(`已下载 ${commit.file}（${body.length} 字节）`);
        // 下载完先自校验：网络截断、以及「当时传上去的就是半个包」都会在这里被抓住，
        // 而不是等恢复跑到一半才发现 —— 那时已经在写盘了。
        const got = await sha256File(local);
        if (got !== head) {
            await removeQuietly(local);
            return {
                report: errorReport(lines, `下载内容与清单不符（期望 ${head.slice(0, 12)}，实得 ${got.slice(0, 12)}），已丢弃`),
                state,
                manifest,
            };
        }
    }
    catch (error) {
        await removeQuietly(local);
        return { report: errorReport(lines, `下载失败：${describe(error)}`), state, manifest };
    }
    try {
        const report = await restorer.restore(local, {
            ...(deps.password === undefined ? {} : { password: deps.password }),
            ...(deps.onLine === undefined ? {} : { onLine: deps.onLine }),
        });
        await removeQuietly(local);
        if (!report.ok) {
            return { report: errorReport(lines, `恢复失败：${report.message}`), state, manifest };
        }
        say(report.message);
        return {
            report: {
                outcome: 'restored',
                message: report.needsRestart > 0
                    ? `已从上游恢复（${report.needsRestart} 项需要重启 DSH 生效）`
                    : '已从上游恢复。',
                localHash: head,
                remoteHash: head,
                file: commit.file,
                tierFellBackTo: '',
                conflict: null,
                lines,
            },
            state: {
                ...state,
                lastSyncedHash: head,
                // 恢复之后本机内容 = 上游内容，两边锚点对齐到同一个 hash
                lastLocalHash: head,
                history: [commit, ...state.history.filter((c) => c.hash !== head)].slice(0, 100),
            },
            manifest,
        };
    }
    catch (error) {
        await removeQuietly(local);
        return { report: errorReport(lines, `恢复失败：${describe(error)}`), state, manifest };
    }
}
/** 冲突的人工裁决。[keep] = 'local' 用本机覆盖上游，'remote' 用上游覆盖本机。 */
export async function resolveConflict(deps) {
    // 复用同一套流程：裁决结果就是把 mode 固定成 push 或 pull 再跑一轮
    return runSync({ ...deps, mode: deps.keep === 'local' ? 'push' : 'pull' });
}
function idle(message, lines) {
    return {
        outcome: 'up-to-date',
        message,
        localHash: '',
        remoteHash: '',
        file: '',
        tierFellBackTo: '',
        conflict: null,
        lines,
    };
}
function errorReport(lines, message) {
    return {
        outcome: 'error',
        message,
        localHash: '',
        remoteHash: '',
        file: '',
        tierFellBackTo: '',
        conflict: null,
        lines,
    };
}
/** 本机标识：只用主机名前 8 位，不上报任何用户信息。 */
export function deviceTag() {
    const host = process.env['HOSTNAME'] ?? '';
    return host === '' ? 'unknown' : host.slice(0, 8);
}
async function removeQuietly(file) {
    await fs.rm(file, { force: true }).catch(() => undefined);
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 把状态重置成「尚未同步」（用户在界面点「忘记上游」时用）。 */
export function resetState() {
    return emptyState();
}
//# sourceMappingURL=sync-engine.js.map