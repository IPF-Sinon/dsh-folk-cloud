/**
 * 同步进度遮罩：阻挡操作 + 阶段步骤 + 上传进度条 + 实时日志 + 动画。
 *
 * 纯展示组件：所有数据由调用方从 status.run（或本次手动动作）传进来。备份/恢复/同步/删除
 * 都复用它，样式走内联 style（这个插件不带 CSS 打包链）。动画用一个只注入一次的 <style>。
 */
import { useEffect, useRef } from 'react';

/** 一次动作会经过的阶段顺序（用来画步骤条 + 判断当前走到第几步）。 */
const PHASE_FLOW: Record<string, readonly string[]> = {
  push: ['preparing', 'producing', 'uploading', 'finalizing', 'done'],
  pull: ['preparing', 'downloading', 'restoring', 'done'],
  delete: ['deleting', 'done'],
};

/** 按当前 phase 猜它属于哪条流程（决定步骤条画哪几步）。 */
function flowFor(phase: string): readonly string[] {
  if (phase === 'downloading' || phase === 'restoring') return PHASE_FLOW['pull']!;
  if (phase === 'deleting') return PHASE_FLOW['delete']!;
  return PHASE_FLOW['push']!;
}

function humanBytes(n: number): string {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const KEYFRAMES = `
@keyframes dfc-spin { to { transform: rotate(360deg); } }
@keyframes dfc-indeterminate { 0% { left: -40%; } 100% { left: 100%; } }
@keyframes dfc-pop { from { transform: translateY(8px) scale(0.98); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dfc-fade { from { opacity: 0; } to { opacity: 1; } }
`;

export interface SyncOverlayProps {
  /** 标题（当前动作名，如「立即同步」）。 */
  title: string;
  /** 当前阶段 id（preparing/producing/uploading/…/done）。 */
  phase: string;
  /** 传输阶段已传/总字节；total>0 时画确定进度条。 */
  uploaded: number;
  total: number;
  /** 实时日志尾部。 */
  lines: string[];
  /** 阶段文案翻译器：传入 phase id 返回可读文案。 */
  phaseLabel: (phase: string) => string;
  /** 「处理中，请勿重复操作」这类提示。 */
  hint: string;
  /** 进度百分比文案模板，含 %p/%a/%b（可选）。 */
  bytesLabel: (uploaded: string, total: string, percent: number) => string;
}

export function SyncOverlay(props: SyncOverlayProps): JSX.Element {
  const { title, phase, uploaded, total, lines, phaseLabel, hint, bytesLabel } = props;
  const flow = flowFor(phase);
  const activeIdx = Math.max(0, flow.indexOf(phase));
  const determinate = total > 0 && phase === 'uploading';
  const percent = determinate ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;

  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // 新日志进来自动滚到底
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        animation: 'dfc-fade 0.15s ease-out',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{KEYFRAMES}</style>
      <div
        style={{
          width: 'min(440px, 92vw)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 20,
          borderRadius: 14,
          border: '1px solid var(--dsh-border, #3a3a3a)',
          background: 'var(--dsh-bg, #1e1e1e)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          animation: 'dfc-pop 0.2s ease-out',
        }}
      >
        {/* 标题 + 旋转指示 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '2px solid var(--dsh-primary, #6aa1ff)',
              borderTopColor: 'transparent',
              display: 'inline-block',
              animation: 'dfc-spin 0.8s linear infinite',
              flex: '0 0 auto',
            }}
          />
          <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
        </div>

        {/* 步骤条 */}
        <div style={{ display: 'flex', gap: 6 }}>
          {flow.filter((p) => p !== 'done').map((p, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            return (
              <div key={p} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{
                    height: 4,
                    borderRadius: 2,
                    background: done || active ? 'var(--dsh-primary, #6aa1ff)' : 'var(--dsh-border, #3a3a3a)',
                    opacity: done ? 0.6 : 1,
                    transition: 'background 0.3s',
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    textAlign: 'center',
                    opacity: active ? 1 : 0.5,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {phaseLabel(p)}
                </span>
              </div>
            );
          })}
        </div>

        {/* 进度条：上传阶段有 total 就画确定进度，否则来回滑动的不确定条 */}
        <div style={{ position: 'relative', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--dsh-border, #3a3a3a)' }}>
          {determinate ? (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${percent}%`,
                background: 'var(--dsh-primary, #6aa1ff)',
                borderRadius: 4,
                transition: 'width 0.2s ease-out',
              }}
            />
          ) : (
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: '40%',
                background: 'var(--dsh-primary, #6aa1ff)',
                borderRadius: 4,
                animation: 'dfc-indeterminate 1.1s ease-in-out infinite',
              }}
            />
          )}
        </div>
        {determinate && (
          <div style={{ fontSize: 12, opacity: 0.75, textAlign: 'right', marginTop: -8 }}>
            {bytesLabel(humanBytes(uploaded), humanBytes(total), percent)}
          </div>
        )}

        {/* 实时日志 */}
        {lines.length > 0 && (
          <pre
            ref={logRef}
            style={{
              margin: 0,
              maxHeight: 140,
              overflow: 'auto',
              fontSize: 11,
              lineHeight: 1.5,
              opacity: 0.8,
              whiteSpace: 'pre-wrap',
              background: 'rgba(0,0,0,0.25)',
              borderRadius: 8,
              padding: 10,
            }}
          >
            {lines.join('\n')}
          </pre>
        )}

        <div style={{ fontSize: 12, opacity: 0.65 }}>{hint}</div>
      </div>
    </div>
  );
}
