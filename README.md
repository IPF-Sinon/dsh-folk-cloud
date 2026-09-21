# dsh-folk-cloud

DSH-Folk 的 WebDAV 云备份插件。把**完整备份**同步到 WebDAV：定时 / DSH 启动后 / 手动触发，
按**内容哈希**去重，上游与本机都有改动时**停下来问用户**，不自动合并。

依赖 [`dsh-config-manager`](https://github.com/xiajiajun516/dsh-config-manager) 的 DSH 分区
读写引擎；软件数据（Android 设置与外观）由 DSH-Folk 宿主 App 通过回环桥提供。

## 为什么单独做一个插件

DSH-Folk 之前的云备份是 App 自己实现的（okhttp + 手写 PROPFIND），能力只有「整包上传/下载」：
没有增量、没有上游历史、也没有「上游被别的设备更新了」这个概念。把这些逻辑放进 DSH 的插件里，
可以复用 DSH 自己的凭据系统与 web 设置页，也让触发器（定时/启动/手动）有一个自然的落点。

与 `dsh-config-manager` 的分工：它管 **DSH 分区**的同步（`<url>/dsh-config-manager/` 下的
分区 JSON 快照），本插件管**整包**云备份（`<url>/dsh-folk/` 下的 zip + manifest）。
两边同级不同目录，互不覆盖。

## 远端布局

```
<WebDAV URL>/<远端目录，默认 dsh-folk>/
  index.json                       ← manifest：「上游提交历史」（时间 / 哈希 / 文件名 / 档位）
  folk-cloud-<时间戳>-<哈希8位>.zip ← 整包备份
```

一个 zip + 一个 json，任何 WebDAV 都能存。**不是**真 git —— 「提交历史」是这份 manifest。

## 同步状态机

三个哈希决定一切：上游 `head`、本机上次对齐的锚点 `lastSyncedHash`、本机此刻产出的 `localHash`。

| 上游变了 | 本机变了 | 动作 |
|---|---|---|
| 否 | 否 | 什么都不做（本地包直接删掉） |
| 否 | 是 | 上传 + 追加 manifest 提交 |
| — | — | 内容与上游 head **完全相同** → 先跳过上传并删除本地包（先去重，再判冲突） |
| 是 | 否 | 下载上游包 → 自校验哈希 → 走恢复 |
| **是** | **是** | **停下报冲突**，等用户选「用本机」或「用上游」 |

冲突永远不自动合并：判错了的后果是覆盖用户的备份。

## 备份档位

| 档位 | 内容 | 谁能做 |
|---|---|---|
| `dsh-only` | DSH 分区（配置/插件/MCP/技能/工作区…），不含凭据原文 | 插件独办 |
| `dsh-vault` | 上述 + 凭据原文（必须加密） | 插件独办 |
| `app-only` | App 设置与外观（背景/字体/音乐/音效） | 需要宿主 App 接口 |
| `app-dsh` | 两边都带（App 里「备份」的默认档位） | 需要宿主 App 接口 |
| `app-dsh-vault` | 最全，含凭据原文（必须加密） | 需要宿主 App 接口 |

含软件数据的档位在**检测不到宿主 App 接口**时自动回退到不含软件数据的档位（保留 vault 语义），
并在界面与日志里如实说明 —— 不会静默降级。

## 触发器

- **定时**：每 N 分钟（0 = 关闭）；
- **DSH 启动后**：延迟 20 秒跑一次（等 dsh 与 dsh-config-manager 就绪）；
- **手动**：设置页的「立即同步 / 只上传 / 只从上游恢复」，或 POST `/api/dsh-folk-cloud/trigger`。

**没有「每轮对话结束」**：DSH 的插件面没有对话回合事件（本插件不 inject `llm`/`tools`，
也没有可用的 turn/message hook）。与其做一个不可靠的近似，不如不做。

## HTTP 接口（loopback-only）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-folk-cloud/status` | 配置状态、档位、触发设置、提交历史、最近一次报告（口令只回布尔） |
| POST | `/api/dsh-folk-cloud/config` | 保存配置（`password` 留空 = 保持原密码） |
| POST | `/api/dsh-folk-cloud/test` | 测试连接 |
| POST | `/api/dsh-folk-cloud/trigger` | 触发一轮：`{mode: auto\|push\|pull, password?}` |
| POST | `/api/dsh-folk-cloud/resolve` | 冲突裁决：`{keep: local\|remote}` |
| POST | `/api/dsh-folk-cloud/forget` | 忘记上游锚点（不删远端任何东西） |

守卫口径与 dsh-config-manager 一致：**回环地址 + 同源**。这些端点会读写备份与下发口令，
绝不能从局域网访问（DSH-Folk 在「局域网访问」开启时 dsh 会监听 0.0.0.0，所以这道检查不是摆设）。

## 安全

- WebDAV 口令走 DSH credentials（引用名 `DSH_FOLK_CLOUD_WEBDAV_PASSWORD`），**永不落盘、永不入日志、
  永不回传给界面**；界面只显示「已配置 / 未配置」，留空即为「不改」。
- 配置文件只存 url 与用户名；地址里的 `user:pass@` 一律拒绝（否则口令会进日志与备份）。
- 下载的包在交给恢复之前先按 manifest 里的哈希自校验，不符即丢弃 —— 不拿半个包去恢复。
- 凭据原文只在 `*-vault` 档位出现，且该档位强制加密。

## 安装

```
dsh plugin --profile web add github:IPF-Sinon/dsh-folk-cloud
# 本地开发：
dsh plugin --profile web add link:<仓库绝对路径>
```

`dsh plugin add` 只有在包的 manifest 带 `dsh.bundle.patch` 时才把它登记进
`dsh.profile.bundles`（本仓库的 `package.json` 指向 `cordis.patch.yml`）；
没有该字段就只是个躺在磁盘上的普通依赖，dsh 不会加载它。

## 开发

```
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build      # tsc（宿主半，ESM）+ tsdown（浏览器半，lib/client.js）
```

`lib/client.js` 必须带 `window.__ModuleLoader__.load({ id: "dsh-folk-cloud", ... })` 包装，
id 必须等于包名 —— CI 里有一步专门校验这个与 `cordis.patch.yml` 的 row id 一致性，
这两种错误只有在真机装载时才会暴露。

## 状态

早期版本，尚未在真机完整验证。已知边界：

- `dsh-config-manager` 是硬依赖，缺它时 DSH 数据无法备份/恢复（界面会明说）；
- 含软件数据的档位需要 DSH-Folk 宿主 App 提供 `/cloud/appdata/*` 接口，旧版 App 会自动回退；
- 恢复是**串行**的：中途失败靠 dsh-config-manager 的快照回滚，不做续跑。
