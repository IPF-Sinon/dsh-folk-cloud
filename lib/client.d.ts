window.__ModuleLoader__.load({
	id: "dsh-folk-cloud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

import { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import "@deepseek-ai/dsh-client-ui-slots";
//#region src/client/locales.d.ts
/**
 * 云备份设置页的文案（zh 主源 / en 镜像）。
 *
 * 键名分类前缀：`section.` 页面级、`field.` 表单字段、`tier.` 备份档位、
 * `action.` 按钮、`state.` 状态与结果。新增键必须两份都加（type 会强制）。
 */
declare const zh: {
  readonly 'section.label': "云备份";
  readonly 'section.desc': "把完整备份同步到 WebDAV：定时/启动后/手动触发，按内容哈希去重，冲突时停下来问你。";
  readonly 'field.url': "WebDAV 地址";
  readonly 'field.url.hint': "例如 https://dav.example.com/dav";
  readonly 'field.username': "用户名";
  readonly 'field.password': "密码";
  readonly 'field.password.keep': "留空 = 保持已保存的密码";
  readonly 'field.remoteDir': "远端子目录";
  readonly 'field.remoteDir.hint': "默认 dsh-folk（与配置管理器的 dsh-config-manager/ 并列）";
  readonly 'tier.label': "备份档位";
  readonly 'tier.dsh-only': "仅 DSH 数据";
  readonly 'tier.dsh-only.desc': "配置、插件清单、MCP、技能、工作区等。不含凭据原文。";
  readonly 'tier.dsh-vault': "仅 DSH 数据（含 vault）";
  readonly 'tier.dsh-vault.desc': "上面那些 + 凭据原文。必须加密。";
  readonly 'tier.app-only': "仅软件数据";
  readonly 'tier.app-only.desc': "App 设置与外观（背景/字体/音乐/音效）。可能不含 DSH 数据。";
  readonly 'tier.app-dsh': "软件数据 + DSH 数据";
  readonly 'tier.app-dsh.desc': "两边都带。这是 App 里「备份」的默认档位。";
  readonly 'tier.app-dsh-vault': "软件数据 + DSH 数据（含 vault）";
  readonly 'tier.app-dsh-vault.desc': "最全的一档，含凭据原文。必须加密。";
  readonly 'field.sessions': "包含会话记录";
  readonly 'field.sessions.desc': "对话历史会显著增大包体积，默认不含。";
  readonly 'field.encrypt': "加密备份包";
  readonly 'field.encrypt.desc': "含 vault 的档位必须开启。加密口令在下方填写并保存，定时/启动后的自动备份也用它。";
  readonly 'field.encryptPassword': "备份加密口令";
  readonly 'field.encryptPassword.keep': "留空 = 保持已保存的加密口令";
  readonly 'field.encryptPassword.needed': "已开启加密但未设加密口令：请在此填写并保存，否则备份会失败（绝不会静默产出未加密的包）。";
  readonly 'trigger.label': "触发方式";
  readonly 'trigger.interval': "定时间隔（分钟）";
  readonly 'trigger.interval.hint': "0 = 关闭定时触发";
  readonly 'trigger.startup': "DSH 启动后自动同步一次";
  readonly 'trigger.manual': "允许手动触发（始终可用）";
  readonly 'action.save': "保存";
  readonly 'action.test': "测试连接";
  readonly 'action.syncNow': "立即同步";
  readonly 'action.push': "只上传";
  readonly 'action.pull': "只从上游恢复";
  readonly 'action.forget': "忘记上游锚点";
  readonly 'action.keepLocal': "用本机覆盖上游";
  readonly 'action.keepRemote': "用上游覆盖本机";
  readonly 'state.loading': "读取中…";
  readonly 'state.saved': "已保存。";
  readonly 'state.testOk': "连接正常。";
  readonly 'state.passwordSet': "已配置";
  readonly 'state.passwordUnset': "未配置";
  readonly 'state.neverSynced': "从未同步";
  readonly 'state.lastSync': "上次同步";
  readonly 'state.appBridgeOk': "宿主 App 软件数据接口：可用";
  readonly 'state.appBridgeMissing': "宿主 App 软件数据接口：不可用（含软件数据的档位会自动回退）";
  readonly 'state.managerMissing': "未检测到 dsh-config-manager：DSH 数据无法备份/恢复，请先安装并启用它。";
  readonly 'state.tierFallback': "当前档位会回退为：%s";
  readonly 'state.running': "同步进行中…";
  readonly 'state.history': "提交历史（本机记录）";
  readonly 'state.history.empty': "还没有提交记录。";
  readonly 'state.conflict.title': "上游与本机都有改动";
  readonly 'state.conflict.desc': "为避免覆盖你的数据，这里不会自动合并：请选择保留哪一边。";
  readonly 'log.title': "最近一次运行的日志";
};
type CloudKey = keyof typeof zh;
//#endregion
//#region src/client/index.d.ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 云备份设置页文案。 */
    'folk-cloud': CloudKey;
  }
}
/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
declare const inject: string[];
declare function apply(ctx: ClientContext): void;
//#endregion
export { apply, inject };

		return module.exports;
	}
});
//# sourceMappingURL=client.d.ts.map