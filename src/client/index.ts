/**
 * 浏览器半：把「云备份」设置页注册进 dsh web GUI。
 *
 * 挂载方式与 dsh-config-manager 完全同构：`settings.section` 是官方 Slot，
 * 经 `ctx.slots.inject(...)` 声明感知注册（声明未到 ledger 前不注册，塌缩时自动移除，
 * 重声明后自动重挂）。本插件注册**自己的**一个 section（id: folk-cloud），
 * 不去改 dsh-config-manager 的页面 —— 两个插件各管一摊，谁坏了都不影响对方。
 */
import type { ClientContext } from './client-types.ts';
// Type-only：拉入 ctx.locale 的 Context 合并（dsh-client-locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only：拉入 settings.section 的 SlotMap 合并（dsh-client-ui-settings）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Type-only：拉入 SlotMap / LocaleNamespaceMap 合并表（dsh-client-ui-slots）。
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import { CloudApi } from './api.ts';
import { CloudSection } from './CloudSection.tsx';
import { en, zh, type CloudKey } from './locales.ts';

/** 本插件拥有的 locale namespace。 */
const NS = 'folk-cloud';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 云备份设置页文案。 */
    'folk-cloud': CloudKey;
  }
}

/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'folk-cloud: dictionaries');
  const t = ctx.locale.bind(NS);
  const api = new CloudApi();

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'folk-cloud',
        // 排在 dsh-config-manager（order 60）之后：用户先看到「备份与迁移」，
        // 再看到依赖它的「云备份」。
        order: 61,
        label: () => t('section.label'),
        locale: NS,
        inject: () => ({ api, t }),
      },
      CloudSection,
    ),
  );
}
