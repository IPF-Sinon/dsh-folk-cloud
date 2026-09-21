/**
 * Client 半的类型集中出口：把对 @deepseek-ai 运行时包的类型依赖收敛到本文件，
 * 其余组件只从这里引用，避免类型散落与误用值导入（与 dsh-config-manager 同一纪律）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';

export type { ClientContext };
export type { TranslateNS };

/** 本插件 Client 半的注入业务面：settings.section 注册项拿到同一个 api 与翻译器。 */
export interface CloudSectionInjected {
  api: import('./api.ts').CloudApi;
  t: TranslateNS<'folk-cloud'>;
}
