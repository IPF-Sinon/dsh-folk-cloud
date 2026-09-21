/**
 * 云备份设置页（settings.section 入口）。
 *
 * ## 结构
 *
 * 一页到底，两个区块，与「备份 / 恢复」两件事一一对应：
 * 1. **备份**：连接（地址/用户名/口令/远端目录）、档位、开关（会话/加密）、触发方式、立即执行；
 * 2. **恢复**：上游提交列表、从上游恢复、冲突裁决（只有在真冲突时才出现）。
 *
 * ## 几个刻意的取舍
 *
 * - **口令字段永远留空回填**：凭据系统不提供读回途径，所以界面只显示「已配置 / 未配置」，
 *   保存时留空 = 保持原密码。这一条在页面上直接写给用户看，免得他以为界面把他的密码弄丢了。
 * - **冲突时不做任何自动选择**：把两个 hash 与远端提交时间摆出来，让用户点「用本机」或「用上游」。
 * - 样式用内联 style，不带 CSS Modules：这个页面结构简单，省掉一条 lightningcss 打包链
 *   （dsh-config-manager 需要它是因为它的界面复杂）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CloudSectionInjected } from './client-types.ts';
import type { CloudStatus, SyncReport } from './api.ts';

export type CloudSectionProps =
  & PropsRuntime<'settings.section'>
  & CloudSectionInjected;

/** 五个档位（与宿主半的 BackupTier 一一对应）。 */
const TIERS = [
  'dsh-only',
  'dsh-vault',
  'app-only',
  'app-dsh',
  'app-dsh-vault',
] as const;

const box: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  border: '1px solid var(--dsh-border, #3a3a3a)',
  borderRadius: 8,
};

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const label: React.CSSProperties = { fontSize: 12, opacity: 0.75, minWidth: 96 };
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 200,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-border, #3a3a3a)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
};
const button: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--dsh-border, #3a3a3a)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
};
const muted: React.CSSProperties = { fontSize: 12, opacity: 0.7 };

export function CloudSection(props: CloudSectionProps): JSX.Element {
  const { api, t } = props;

  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);

  // 表单
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remoteDir, setRemoteDir] = useState('dsh-folk');
  const [tier, setTier] = useState<string>('app-dsh');
  const [includeSessions, setIncludeSessions] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [onStartup, setOnStartup] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setUrl(s.url);
      setUsername(s.username);
      setRemoteDir(s.remoteDir);
      setTier(s.tier);
      setIncludeSessions(s.includeSessions);
      setEncrypt(s.encrypt);
      setIntervalMinutes(s.trigger.intervalMinutes);
      setOnStartup(s.trigger.onStartup);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 统一的「跑一件事」包装：忙碌标记 + 错误/结果归位。 */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      await api.save({
        url,
        username,
        // 留空 = 保持原密码：不下发 password 字段，插件的 mergeConfig 就不会动它
        ...(password === '' ? {} : { password }),
        remoteDir,
        tier,
        includeSessions,
        encrypt,
        trigger: { intervalMinutes, onStartup },
      });
      setPassword('');
      setNote(t('state.saved'));
      await refresh();
    });

  const test = (): Promise<void> =>
    run(async () => {
      await api.test(url, username, password);
      setNote(t('state.testOk'));
    });

  const syncNow = (): Promise<void> =>
    run(async () => {
      const r = await api.trigger('auto', password === '' ? undefined : password);
      setReport(r);
      await refresh();
    });

  const resolve = (keep: 'local' | 'remote'): Promise<void> =>
    run(async () => {
      const r = await api.resolve(keep, password === '' ? undefined : password);
      setReport(r);
      await refresh();
    });

  if (status === null && error === '') {
    return <div style={{ padding: 16 }}>{t('state.loading')}</div>;
  }

  const passwordState = status?.passwordConfigured ? t('state.passwordSet') : t('state.passwordUnset');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, overflow: 'auto' }}>
      <header>
        <div style={{ fontWeight: 600 }}>{t('section.label')}</div>
        <div style={muted}>{t('section.desc')}</div>
      </header>

      {/* 依赖状态：dsh-config-manager 是硬依赖，缺了整页功能都不成立，必须醒目 */}
      {status?.configManagerAvailable === false && (
        <div style={{ ...box, borderColor: '#a33' }}>{t('state.managerMissing')}</div>
      )}

      {/* ───────── 备份 ───────── */}
      <section style={box}>
        <div style={{ fontWeight: 600 }}>{t('section.label')}</div>

        <div style={row}>
          <span style={label}>{t('field.url')}</span>
          <input style={input} value={url} placeholder={t('field.url.hint')} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div style={row}>
          <span style={label}>{t('field.username')}</span>
          <input style={input} value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div style={row}>
          <span style={label}>{t('field.password')}</span>
          <input
            style={input}
            type="password"
            value={password}
            placeholder={`${passwordState} · ${t('field.password.keep')}`}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div style={row}>
          <span style={label}>{t('field.remoteDir')}</span>
          <input style={input} value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)} />
        </div>
        <div style={muted}>{t('field.remoteDir.hint')}</div>

        <div style={{ ...row, alignItems: 'flex-start' }}>
          <span style={label}>{t('tier.label')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            {TIERS.map((id) => (
              <label key={id} style={{ ...row, gap: 6, cursor: 'pointer' }}>
                <input type="radio" checked={tier === id} onChange={() => setTier(id)} />
                <span>
                  {t(`tier.${id}` as 'tier.dsh-only')}
                  <span style={muted}> — {t(`tier.${id}.desc` as 'tier.dsh-only.desc')}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {status?.tierFellBack === true && (
          <div style={{ ...muted, color: '#c96' }}>
            {t('state.tierFallback').replace('%s', t(`tier.${status.effectiveTier}` as 'tier.dsh-only'))}
          </div>
        )}
        <div style={muted}>{status?.appBridgeAvailable ? t('state.appBridgeOk') : t('state.appBridgeMissing')}</div>

        <label style={{ ...row, gap: 6 }}>
          <input type="checkbox" checked={includeSessions} onChange={(e) => setIncludeSessions(e.target.checked)} />
          <span>
            {t('field.sessions')}
            <span style={muted}> — {t('field.sessions.desc')}</span>
          </span>
        </label>
        <label style={{ ...row, gap: 6 }}>
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          <span>
            {t('field.encrypt')}
            <span style={muted}> — {t('field.encrypt.desc')}</span>
          </span>
        </label>

        <div style={{ fontWeight: 600, marginTop: 4 }}>{t('trigger.label')}</div>
        <div style={row}>
          <span style={label}>{t('trigger.interval')}</span>
          <input
            style={{ ...input, maxWidth: 120 }}
            type="number"
            min={0}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)}
          />
          <span style={muted}>{t('trigger.interval.hint')}</span>
        </div>
        <label style={{ ...row, gap: 6 }}>
          <input type="checkbox" checked={onStartup} onChange={(e) => setOnStartup(e.target.checked)} />
          <span>{t('trigger.startup')}</span>
        </label>
        <div style={muted}>{t('trigger.manual')}</div>

        <div style={row}>
          <button style={button} disabled={busy} onClick={() => void save()}>
            {t('action.save')}
          </button>
          <button style={button} disabled={busy} onClick={() => void test()}>
            {t('action.test')}
          </button>
          <button style={button} disabled={busy || status?.run.running === true} onClick={() => void syncNow()}>
            {t('action.syncNow')}
          </button>
          <button style={button} disabled={busy} onClick={() => void run(async () => {
            setReport(await api.trigger('push', password === '' ? undefined : password));
            await refresh();
          })}>
            {t('action.push')}
          </button>
          <button style={button} disabled={busy} onClick={() => void run(async () => {
            setReport(await api.trigger('pull', password === '' ? undefined : password));
            await refresh();
          })}>
            {t('action.pull')}
          </button>
        </div>
        {status?.run.running === true && <div style={muted}>{t('state.running')}</div>}
        {note !== '' && <div style={{ ...muted, color: '#6a6' }}>{note}</div>}
        {error !== '' && <div style={{ ...muted, color: '#c66' }}>{error}</div>}
      </section>

      {/* ───────── 恢复 ───────── */}
      <section style={box}>
        <div style={{ fontWeight: 600 }}>{t('state.history')}</div>
        <div style={muted}>
          {t('state.lastSync')}: {status?.lastSyncedHash === '' ? t('state.neverSynced') : status?.lastSyncedHash.slice(0, 12)}
        </div>
        {(status?.history.length ?? 0) === 0 && <div style={muted}>{t('state.history.empty')}</div>}
        {(status?.history ?? []).map((c) => (
          <div key={c.hash} style={{ ...row, justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'monospace' }}>{c.hash.slice(0, 12)}</span>
            <span style={muted}>{new Date(c.at).toLocaleString()}</span>
            <span style={muted}>{c.file}</span>
            <span style={muted}>{c.tier}</span>
          </div>
        ))}
        <div style={row}>
          <button style={button} disabled={busy} onClick={() => void run(async () => {
            setReport(await api.trigger('pull', password === '' ? undefined : password));
            await refresh();
          })}>
            {t('action.pull')}
          </button>
          <button style={button} disabled={busy} onClick={() => void run(async () => {
            await api.forget();
            setNote(t('state.saved'));
            await refresh();
          })}>
            {t('action.forget')}
          </button>
        </div>
      </section>

      {/* ───────── 冲突 ───────── */}
      {report?.outcome === 'conflict' && report.conflict !== null && (
        <section style={{ ...box, borderColor: '#c96' }}>
          <div style={{ fontWeight: 600 }}>{t('state.conflict.title')}</div>
          <div style={muted}>{t('state.conflict.desc')}</div>
          <div style={muted}>
            upstream {report.conflict.remoteHash.slice(0, 12)}
            {report.conflict.remoteAt === '' ? '' : ` @ ${new Date(report.conflict.remoteAt).toLocaleString()}`}
            {' · '}
            local {report.conflict.localHash.slice(0, 12)}
          </div>
          <div style={row}>
            <button style={button} disabled={busy} onClick={() => void resolve('local')}>
              {t('action.keepLocal')}
            </button>
            <button style={button} disabled={busy} onClick={() => void resolve('remote')}>
              {t('action.keepRemote')}
            </button>
          </div>
        </section>
      )}

      {/* ───────── 结果与日志 ───────── */}
      {report !== null && report.outcome !== 'conflict' && (
        <section style={box}>
          <div style={{ fontWeight: 600 }}>{t('log.title')}</div>
          <div>{report.message}</div>
          <pre style={{ ...muted, whiteSpace: 'pre-wrap', margin: 0, maxHeight: 200, overflow: 'auto' }}>
            {report.lines.join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}
