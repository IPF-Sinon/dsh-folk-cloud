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
import { SyncOverlay } from './SyncOverlay.tsx';

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

/**
 * 含**软件数据**的档位 —— 只有这些档位里才有外观主题，主题开关也只在这几档下显示与检测。
 * 与宿主 App 的 scopeForTier（app-only / app-dsh / app-dsh-vault）保持同一口径。
 */
const TIERS_WITH_APP: readonly string[] = ['app-only', 'app-dsh', 'app-dsh-vault'];

/** 字节数换成人类可读（与宿主日志里的写法一致，便于对照）。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  // 进度弹窗显示的当前动作名（保存/测试/同步/上传/恢复…）。
  const [busyLabel, setBusyLabel] = useState('');
  const [report, setReport] = useState<SyncReport | null>(null);

  // 表单
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [encryptPassword, setEncryptPassword] = useState('');
  const [remoteDir, setRemoteDir] = useState('dsh-folk');
  const [tier, setTier] = useState<string>('app-dsh');
  const [includeSessions, setIncludeSessions] = useState(false);
  /**
   * 是否把外观主题打进包。**undefined = 自动**（按宿主报的主题包大小定，超过 5MB 就不含）。
   * 只有用户拨过开关才会有值，这样换主题后默认值能一直跟上。
   */
  const [includeTheme, setIncludeTheme] = useState<boolean | undefined>(undefined);
  /** 宿主 App 量出来的主题包信息；null = 还没拿到（检测中或桥不可用）。 */
  const [themeSize, setThemeSize] = useState<{ sizeBytes: number; limitBytes: number; defaultInclude: boolean } | null>(null);
  const [themeChecking, setThemeChecking] = useState(false);
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
      setIncludeTheme(s.includeTheme);
      setEncrypt(s.encrypt);
      setIntervalMinutes(s.trigger.intervalMinutes);
      setOnStartup(s.trigger.onStartup);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  // 只更新 status（run/history），**不碰表单字段** —— 轮询时若把 url/tier 等一并回填，
  // 会把用户正在输入的内容冲掉。所以运行态跟随用这个，完整回填只在首屏/保存后用 refresh。
  const pollStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch {
      /* 轮询失败静默：下一拍再试，别打断用户 */
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 主题包大小只在「档位含软件数据 + App 补包接口可用」时检测 —— 与开关的显示条件完全一致。
   *
   * 默认档位（app-dsh）就含软件数据，所以进页面就会检测一次并按大小定出默认值（需求里那句
   * 「默认配置时也检测一遍进行自动选择」）；换成不含软件数据的档位就不检测、也不显示。
   * 失败（桥不可用/老版本 App）保持 null，界面按「含主题」处理，不替用户把主题排除掉。
   */
  useEffect(() => {
    const needsApp = TIERS_WITH_APP.includes(tier) && status?.appBridgeAvailable === true;
    if (!needsApp || themeSize !== null || themeChecking) return;
    let cancelled = false;
    setThemeChecking(true);
    void (async () => {
      const info = await api.themeInfo();
      if (cancelled) return;
      setThemeSize(info === null ? null : { sizeBytes: info.sizeBytes, limitBytes: info.limitBytes, defaultInclude: info.defaultInclude });
      setThemeChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, tier, status?.appBridgeAvailable, themeSize, themeChecking]);

  // 常驻轮询：每 1.5s 只刷 status。这样自动/后台/手动触发的进度、日志、历史都能实时跟随，
  // 用户即便不点任何东西、或刷新页面重进，也能看到「正在同步」而不是一片空白。
  useEffect(() => {
    const timer = setInterval(() => {
      void pollStatus();
    }, 1500);
    return () => clearInterval(timer);
  }, [pollStatus]);

  /** 统一的「跑一件事」包装：忙碌标记 + 进度弹窗文案 + 错误/结果归位。 */
  const run = async (fn: () => Promise<void>, label = ''): Promise<void> => {
    setBusy(true);
    setBusyLabel(label);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setBusyLabel('');
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
        // 缺席 = 继续自动（不把自动结果固化成用户选择）
        ...(includeTheme === undefined ? {} : { includeTheme }),
        encrypt,
        // 加密口令同理：留空 = 保持已存的
        ...(encryptPassword === '' ? {} : { encryptPassword }),
        trigger: { intervalMinutes, onStartup },
      });
      setPassword('');
      setEncryptPassword('');
      setNote(t('state.saved'));
      await refresh();
    }, t('action.save'));

  const test = (): Promise<void> =>
    run(async () => {
      await api.test(url, username, password);
      setNote(t('state.testOk'));
    }, t('action.test'));

  const syncNow = (): Promise<void> =>
    run(async () => {
      const r = await api.trigger('auto', password === '' ? undefined : password);
      setReport(r);
      await refresh();
    }, t('action.syncNow'));

  const resolve = (keep: 'local' | 'remote'): Promise<void> =>
    run(async () => {
      const r = await api.resolve(keep, password === '' ? undefined : password);
      setReport(r);
      await refresh();
    }, keep === 'local' ? t('action.keepLocal') : t('action.keepRemote'));

  /** 恢复某个历史版本：用那一版覆盖本机（会先弹确认，避免误点）。 */
  const restore = (hash: string): Promise<void> =>
    run(async () => {
      const r = await api.restore(hash, password === '' ? undefined : password);
      setReport(r);
      await refresh();
    }, t('action.restoreThis'));

  /** 从云端永久删除某个历史版本（会先弹确认，破坏性）。 */
  const remove = (hash: string): Promise<void> =>
    run(async () => {
      const r = await api.deleteCommit(hash);
      setReport(r);
      await refresh();
    }, t('action.deleteThis'));

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
              <label key={id} style={{ ...row, gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" checked={tier === id} onChange={() => setTier(id)} />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span>{t(`tier.${id}` as 'tier.dsh-only')}：</span>
                  <span style={muted}>{t(`tier.${id}.desc` as 'tier.dsh-only.desc')}</span>
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

        {/* 外观主题开关：只在与上面档位同一条件下显示（含软件数据 + 补包接口可用）。
            勾选状态 = 用户显式选择 ?? 宿主按大小给的推荐值；未拨过时在标题后标注「自动」。 */}
        {TIERS_WITH_APP.includes(tier) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...row, gap: 6 }}>
              <input
                type="checkbox"
                checked={includeTheme ?? themeSize?.defaultInclude ?? true}
                onChange={(e) => setIncludeTheme(e.target.checked)}
              />
              <span>
                {t('field.theme')}
                {includeTheme === undefined && <span style={muted}>（{t('state.themeAuto')}）</span>}
                <span style={muted}> — {t('field.theme.desc')}</span>
              </span>
            </label>
            <div style={muted}>
              {themeChecking
                ? t('state.themeChecking')
                : themeSize === null
                  ? t('state.themeUnknown')
                  : t('state.themeSize')
                      .replace('%s', formatBytes(themeSize.sizeBytes))
                      .replace('%l', formatBytes(themeSize.limitBytes))}
            </div>
            {themeSize !== null && !themeSize.defaultInclude && (includeTheme ?? themeSize.defaultInclude) && (
              <div style={{ ...muted, color: '#c96' }}>{t('state.themeTooBig')}</div>
            )}
          </div>
        )}

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
        <div style={row}>
          <span style={label}>{t('field.encryptPassword')}</span>
          <input
            style={input}
            type="password"
            value={encryptPassword}
            placeholder={`${status?.encryptPasswordConfigured ? t('state.passwordSet') : t('state.passwordUnset')} · ${t('field.encryptPassword.keep')}`}
            onChange={(e) => setEncryptPassword(e.target.value)}
          />
        </div>
        {encrypt && status?.encryptPasswordConfigured === false && (
          <div style={{ ...muted, color: '#c96' }}>{t('field.encryptPassword.needed')}</div>
        )}

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
          }, t('action.push'))}>
            {t('action.push')}
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
            <div style={{ display: 'flex', gap: 6 }}>
              {/* 删除在左：从云端永久删掉这一版（破坏性，先弹确认）。 */}
              <button
                style={{ ...button, borderColor: '#a55', color: '#e88' }}
                disabled={busy || status?.run.running === true}
                onClick={() => {
                  if (typeof window !== 'undefined' &&
                    !window.confirm(t('confirm.delete').replace('%s', c.hash.slice(0, 12)))) return;
                  void remove(c.hash);
                }}
              >
                {t('action.deleteThis')}
              </button>
              <button
                style={button}
                disabled={busy || status?.run.running === true}
                onClick={() => {
                  // 覆盖本机是破坏性动作：先弹一次确认，避免误点。
                  if (typeof window !== 'undefined' &&
                    !window.confirm(t('confirm.restore').replace('%s', c.hash.slice(0, 12)))) return;
                  void restore(c.hash);
                }}
              >
                {t('action.restoreThis')}
              </button>
            </div>
          </div>
        ))}
        <div style={row}>
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
      {/* ───────── 进度弹窗（阻挡操作，避免重复点击 / 不知道点没点到）───────── */}
      {(busy || status?.run.running === true) && (
        <SyncOverlay
          title={busyLabel !== '' ? busyLabel : t('state.running')}
          phase={status?.run.phase ?? 'preparing'}
          uploaded={status?.run.uploaded ?? 0}
          total={status?.run.total ?? 0}
          lines={status?.run.lines ?? []}
          phaseLabel={(p) => t(`phase.${p}` as 'phase.preparing')}
          hint={t('state.busyHint')}
          bytesLabel={(u, tot, pct) =>
            t('progress.bytes').replace('%a', u).replace('%b', tot).replace('%p', String(pct))}
        />
      )}
    </div>
  );
}
