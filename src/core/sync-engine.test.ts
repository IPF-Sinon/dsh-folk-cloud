/**
 * 同步状态机的测试。
 *
 * 这里全部用**假**的传输/产出/恢复实现，把决策逻辑单独拉出来跑：
 * 「上游变了吗 / 本机变了吗」这四种组合各自该做什么，是这套插件最容易错的地方
 * （错了的后果是覆盖用户的备份），所以它必须能被穷举。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  emptyState,
  type CloudConfig,
  type CloudState,
  type RemoteManifest,
} from './config.ts';
import { runSync, resolveConflict, type BackupProducer, type BackupRestorer, type ProducedBackup } from './sync-engine.ts';
import { sha256File } from './store.ts';
import type { WebdavTransport } from '../webdav/transport.ts';

/** 内存里的假 WebDAV：一张 path → Buffer 的表。 */
class FakeTransport {
  readonly files = new Map<string, Buffer>();

  async get(file: string): Promise<Buffer | null> {
    return this.files.get(file) ?? null;
  }

  async put(file: string, body: Buffer): Promise<void> {
    this.files.set(file, Buffer.from(body));
  }

  async ensureDir(): Promise<void> {
    /* 内存实现无需建目录 */
  }

  async delete(file: string): Promise<void> {
    this.files.delete(file);
  }

  async list(): Promise<never[]> {
    return [];
  }
}

function asTransport(fake: FakeTransport): WebdavTransport {
  return fake as unknown as WebdavTransport;
}

/** 假产出器：把给定内容写成文件，声称的档位可配。 */
function producer(content: string, opts: { tier?: CloudConfig['tier']; fellBack?: boolean } = {}): BackupProducer {
  return {
    async produce(outDir: string, tier): Promise<ProducedBackup> {
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, 'local-backup.zip');
      await fs.writeFile(file, content);
      const size = (await fs.stat(file)).size;
      return {
        file,
        tier: opts.tier ?? tier,
        tierFellBack: opts.fellBack === true,
        size,
      };
    },
  };
}

/** 假恢复器：记下被恢复的文件内容。 */
function restorer(sink: { calls: string[]; ok?: boolean }): BackupRestorer {
  return {
    async restore(file) {
      sink.calls.push(await fs.readFile(file, 'utf8'));
      return { ok: sink.ok !== false, message: 'restored', needsRestart: 0 };
    },
  };
}

/** 算出「本机产出这份内容时」的哈希 —— 锚点断言要用它，不能拿字面量瞎凑。 */
async function hashOf(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folk-cloud-hash-'));
  const file = path.join(dir, 'h.zip');
  await fs.writeFile(file, content);
  return sha256File(file);
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'folk-cloud-test-'));
}

function cfg(over: Partial<CloudConfig> = {}): CloudConfig {
  return { ...DEFAULT_CONFIG, url: 'https://dav.example.com/dav', remoteDir: 'dsh-folk', ...over };
}

/** 造一个「上游有某份内容」的 manifest + 文件。 */
async function seedRemote(fake: FakeTransport, content: string, commitAt = '2026-01-01T00:00:00.000Z'): Promise<string> {
  const dir = await tmpDir();
  const file = path.join(dir, 'remote.zip');
  await fs.writeFile(file, content);
  const hash = await sha256File(file);
  const name = 'folk-cloud-20260101-000000-aaaaaaaa.zip';
  fake.files.set(`dsh-folk/${name}`, Buffer.from(content));
  const manifest: RemoteManifest = {
    schemaVersion: 1,
    head: hash,
    commits: [{ hash, at: commitAt, file: name, size: content.length, tier: 'dsh-only', device: 'test' }],
  };
  fake.files.set('dsh-folk/index.json', Buffer.from(JSON.stringify(manifest)));
  return hash;
}

test('上游没变、本机也没变 → 什么都不做，且本地包被删掉', async () => {
  const fake = new FakeTransport();
  const head = await seedRemote(fake, 'SAME');
  const work = await tmpDir();
  const state: CloudState = { ...emptyState(), lastSyncedHash: head, lastLocalHash: head };
  const sink = { calls: [] as string[] };

  const { report } = await runSync({
    transport: asTransport(fake),
    producer: producer('SAME'),
    restorer: restorer(sink),
    config: cfg(),
    state,
    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'up-to-date');
  assert.equal(sink.calls.length, 0, '不该恢复');
  // 本地那份包要被清掉：一致性成立时留着它只会占地方
  const left = await fs.readdir(path.join(work, 'tmp')).catch(() => []);
  assert.deepEqual(left, []);
});

test('上游没变、本机变了 → 上传并更新上游清单', async () => {
  const fake = new FakeTransport();
  const head = await seedRemote(fake, 'OLD');
  const work = await tmpDir();
  const state: CloudState = { ...emptyState(), lastSyncedHash: head, lastLocalHash: head };

  const { report, state: next } = await runSync({
    transport: asTransport(fake),
    producer: producer('NEW-CONTENT'),
    restorer: restorer({ calls: [] }),
    config: cfg(),
    state,
    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'uploaded');
  assert.ok(report.file.startsWith('folk-cloud-'), '文件名带前缀');
  assert.ok(fake.files.has(`dsh-folk/${report.file}`), '包真的传上去了');
  // 清单要指向新哈希，且旧提交仍然保留（历史不能被抹掉）
  const manifest = JSON.parse((fake.files.get('dsh-folk/index.json') as Buffer).toString('utf8')) as RemoteManifest;
  assert.equal(manifest.head, report.localHash);
  assert.equal(manifest.commits.length, 2, '旧提交保留');
  assert.equal(next.lastSyncedHash, report.localHash);
});

test('上游变了、本机没变 → 下载并恢复，锚点对齐', async () => {
  const fake = new FakeTransport();
  const remoteHash = await seedRemote(fake, 'FROM-REMOTE');
  const work = await tmpDir();
  const sink = { calls: [] as string[] };
  // 「本机没变」的准确定义：**用同一套档位重出一份备份，其内容哈希等于上次的锚点**。
  // （不是「没人碰过机器」——产出器每次都会重新打包，比的就是这个哈希。）
  const anchor = await hashOf('LOCAL-UNCHANGED');

  const { report, state: next } = await runSync({
    transport: asTransport(fake),
    producer: producer('LOCAL-UNCHANGED'),
    restorer: restorer(sink),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: anchor, lastLocalHash: anchor },
    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'restored');
  assert.deepEqual(sink.calls, ['FROM-REMOTE'], '恢复的是上游那份内容');
  assert.equal(next.lastSyncedHash, remoteHash);
});

test('上游变了、本机也变了 → 停下报冲突（绝不自动合并）', async () => {
  const fake = new FakeTransport();
  const remoteHash = await seedRemote(fake, 'REMOTE-NEW');
  const work = await tmpDir();
  const sink = { calls: [] as string[] };

  const { report, state: next } = await runSync({
    transport: asTransport(fake),
    producer: producer('LOCAL-NEW'),
    restorer: restorer(sink),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: await hashOf('OLD-LOCAL'), lastLocalHash: await hashOf('OLD-LOCAL') },
    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'conflict');
  assert.equal(sink.calls.length, 0, '冲突时不许恢复（会覆盖本地）');
  assert.equal(next.lastSyncedHash, await hashOf('OLD-LOCAL'), '冲突不推进锚点');
  assert.ok(report.conflict !== null);
  assert.equal(report.conflict?.remoteHash, remoteHash);
  assert.equal(report.conflict?.localHash, report.localHash);
});

test('内容与上游 head 完全相同 → 跳过上传并删除本地包', async () => {
  const fake = new FakeTransport();
  const work = await tmpDir();
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  await fs.writeFile(file, 'IDENTICAL');
  const hash = await sha256File(file);
  // 上游 head 就是这份内容，但本机锚点是别的（模拟「换了台机器，内容其实一样」）
  await seedRemote(fake, 'IDENTICAL');
  assert.equal(hash.length, 64);

  const { report } = await runSync({
    transport: asTransport(fake),
    producer: producer('IDENTICAL'),
    restorer: restorer({ calls: [] }),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: 'other-anchor', lastLocalHash: 'other-anchor' },

    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'skipped-identical');
  assert.equal(report.file, '', '不上传');
  const files = [...fake.files.keys()].filter((k) => k.endsWith('.zip'));
  assert.equal(files.length, 1, '远端不该多出文件');
});

test('人工裁决 keep=remote → 走恢复', async () => {
  const fake = new FakeTransport();
  await seedRemote(fake, 'REMOTE-WINS');
  const work = await tmpDir();
  const sink = { calls: [] as string[] };

  const { report } = await resolveConflict({
    transport: asTransport(fake),
    producer: producer('LOCAL'),
    restorer: restorer(sink),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: await hashOf('old'), lastLocalHash: await hashOf('old') },
    workDir: work,
    keep: 'remote',
  });

  assert.equal(report.outcome, 'restored');
  assert.deepEqual(sink.calls, ['REMOTE-WINS']);
});

test('人工裁决 keep=local → 走上传', async () => {
  const fake = new FakeTransport();
  await seedRemote(fake, 'REMOTE');
  const work = await tmpDir();

  const { report } = await resolveConflict({
    transport: asTransport(fake),
    producer: producer('LOCAL-WINS'),
    restorer: restorer({ calls: [] }),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: await hashOf('old'), lastLocalHash: await hashOf('old') },
    workDir: work,
    keep: 'local',
  });

  assert.equal(report.outcome, 'uploaded');
});

test('下载内容与清单哈希不符 → 丢弃并报错（不拿半个包去恢复）', async () => {
  const fake = new FakeTransport();
  const hash = await seedRemote(fake, 'GOOD');
  // 篡改远端文件，让它的内容与清单里的 hash 不一致
  const name = 'folk-cloud-20260101-000000-aaaaaaaa.zip';
  fake.files.set(`dsh-folk/${name}`, Buffer.from('TAMPERED'));
  const work = await tmpDir();
  const sink = { calls: [] as string[] };

  const { report } = await runSync({
    transport: asTransport(fake),
    producer: producer('LOCAL'),
    restorer: restorer(sink),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: hash, lastLocalHash: hash },
    workDir: work,
    mode: 'pull',
  });

  assert.equal(report.outcome, 'error');
  assert.match(report.message, /与清单不符/);
  assert.equal(sink.calls.length, 0, '不许把不一致的包交给恢复');
});

test('上游为空时 pull 不报错（第一次用不该是错误）', async () => {
  const fake = new FakeTransport();
  const work = await tmpDir();

  const { report } = await runSync({
    transport: asTransport(fake),
    producer: producer('X'),
    restorer: restorer({ calls: [] }),
    config: cfg(),
    state: emptyState(),
    workDir: work,
    mode: 'pull',
  });

  assert.equal(report.outcome, 'up-to-date');
  assert.match(report.message, /还没有备份/);
});

test('档位回退要如实上报（App 补包接口不可用）', async () => {
  const fake = new FakeTransport();
  const work = await tmpDir();

  const { report } = await runSync({
    transport: asTransport(fake),
    producer: producer('WITH-FALLBACK', { tier: 'dsh-only', fellBack: true }),
    restorer: restorer({ calls: [] }),
    config: cfg({ tier: 'app-dsh' }),
    state: emptyState(),
    workDir: work,
    mode: 'auto',
  });

  assert.equal(report.outcome, 'uploaded');
  assert.equal(report.tierFellBackTo, 'dsh-only');
  assert.ok(
    report.lines.some((l) => l.includes('档位已回退')),
    '日志里要说明回退，不能静默降级',
  );
});

test('恢复失败时不推进锚点（下次还会重试）', async () => {
  const fake = new FakeTransport();
  await seedRemote(fake, 'REMOTE');
  const work = await tmpDir();
  const anchor = await hashOf('LOCAL');

  const { report, state: next } = await runSync({
    transport: asTransport(fake),
    producer: producer('LOCAL'),
    restorer: restorer({ calls: [], ok: false }),
    config: cfg(),
    state: { ...emptyState(), lastSyncedHash: anchor, lastLocalHash: anchor },
    workDir: work,
    mode: 'pull',
  });

  assert.equal(report.outcome, 'error');
  assert.equal(next.lastSyncedHash, anchor, '失败不推进锚点');
});
