window.__ModuleLoader__.load({
	id: "dsh-folk-cloud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/api.ts
async function readJson(res) {
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text === "" ? null : JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (!res.ok) {
		const detail = parsed?.error;
		throw new Error(detail ?? `HTTP ${res.status}`);
	}
	return parsed;
}
var CloudApi = class {
	async status() {
		return readJson(await fetch("/api/dsh-folk-cloud/status"));
	}
	async save(draft) {
		return readJson(await fetch("/api/dsh-folk-cloud/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(draft)
		}));
	}
	/** 测试连接。`password` 留空则用已保存的口令。 */
	async test(url, username, password) {
		await readJson(await fetch("/api/dsh-folk-cloud/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url,
				username,
				password
			})
		}));
	}
	/** 立即执行一轮。mode: auto 按状态机决定推或拉；push/pull 强制单向。 */
	async trigger(mode, password) {
		return readJson(await fetch("/api/dsh-folk-cloud/trigger", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode,
				...password === void 0 ? {} : { password }
			})
		}));
	}
	/** 冲突裁决：keep = local 用本机覆盖上游，remote 用上游覆盖本机。 */
	async resolve(keep, password) {
		return readJson(await fetch("/api/dsh-folk-cloud/resolve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				keep,
				...password === void 0 ? {} : { password }
			})
		}));
	}
	/** 忘记上游锚点（不删远端任何东西）。 */
	async forget() {
		await readJson(await fetch("/api/dsh-folk-cloud/forget", { method: "POST" }));
	}
};
//#endregion
//#region src/client/CloudSection.tsx
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
/** 五个档位（与宿主半的 BackupTier 一一对应）。 */
const TIERS = [
	"dsh-only",
	"dsh-vault",
	"app-only",
	"app-dsh",
	"app-dsh-vault"
];
const box = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: 12,
	border: "1px solid var(--dsh-border, #3a3a3a)",
	borderRadius: 8
};
const row = {
	display: "flex",
	gap: 8,
	alignItems: "center",
	flexWrap: "wrap"
};
const label = {
	fontSize: 12,
	opacity: .75,
	minWidth: 96
};
const input = {
	flex: 1,
	minWidth: 200,
	padding: "6px 8px",
	borderRadius: 6,
	border: "1px solid var(--dsh-border, #3a3a3a)",
	background: "transparent",
	color: "inherit",
	font: "inherit"
};
const button = {
	padding: "6px 12px",
	borderRadius: 6,
	border: "1px solid var(--dsh-border, #3a3a3a)",
	background: "transparent",
	color: "inherit",
	cursor: "pointer",
	font: "inherit"
};
const muted = {
	fontSize: 12,
	opacity: .7
};
function CloudSection(props) {
	const { api, t } = props;
	const [status, setStatus] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)("");
	const [note, setNote] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [report, setReport] = (0, react.useState)(null);
	const [url, setUrl] = (0, react.useState)("");
	const [username, setUsername] = (0, react.useState)("");
	const [password, setPassword] = (0, react.useState)("");
	const [remoteDir, setRemoteDir] = (0, react.useState)("dsh-folk");
	const [tier, setTier] = (0, react.useState)("app-dsh");
	const [includeSessions, setIncludeSessions] = (0, react.useState)(false);
	const [encrypt, setEncrypt] = (0, react.useState)(true);
	const [intervalMinutes, setIntervalMinutes] = (0, react.useState)(60);
	const [onStartup, setOnStartup] = (0, react.useState)(true);
	const refresh = (0, react.useCallback)(async () => {
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
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [api]);
	(0, react.useEffect)(() => {
		refresh();
	}, [refresh]);
	/** 统一的「跑一件事」包装：忙碌标记 + 错误/结果归位。 */
	const run = async (fn) => {
		setBusy(true);
		setError("");
		setNote("");
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const save = () => run(async () => {
		await api.save({
			url,
			username,
			...password === "" ? {} : { password },
			remoteDir,
			tier,
			includeSessions,
			encrypt,
			trigger: {
				intervalMinutes,
				onStartup
			}
		});
		setPassword("");
		setNote(t("state.saved"));
		await refresh();
	});
	const test = () => run(async () => {
		await api.test(url, username, password);
		setNote(t("state.testOk"));
	});
	const syncNow = () => run(async () => {
		const r = await api.trigger("auto", password === "" ? void 0 : password);
		setReport(r);
		await refresh();
	});
	const resolve = (keep) => run(async () => {
		const r = await api.resolve(keep, password === "" ? void 0 : password);
		setReport(r);
		await refresh();
	});
	if (status === null && error === "") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: { padding: 16 },
		children: t("state.loading")
	});
	const passwordState = status?.passwordConfigured ? t("state.passwordSet") : t("state.passwordUnset");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 16,
			padding: 16,
			overflow: "auto"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { fontWeight: 600 },
				children: t("section.label")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: muted,
				children: t("section.desc")
			})] }),
			status?.configManagerAvailable === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					...box,
					borderColor: "#a33"
				},
				children: t("state.managerMissing")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: box,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 600 },
						children: t("section.label")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("field.url")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: input,
							value: url,
							placeholder: t("field.url.hint"),
							onChange: (e) => setUrl(e.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("field.username")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: input,
							value: username,
							onChange: (e) => setUsername(e.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("field.password")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: input,
							type: "password",
							value: password,
							placeholder: `${passwordState} · ${t("field.password.keep")}`,
							onChange: (e) => setPassword(e.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("field.remoteDir")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: input,
							value: remoteDir,
							onChange: (e) => setRemoteDir(e.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("field.remoteDir.hint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...row,
							alignItems: "flex-start"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("tier.label")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4,
								flex: 1
							},
							children: TIERS.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...row,
									gap: 6,
									cursor: "pointer"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "radio",
									checked: tier === id,
									onChange: () => setTier(id)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t(`tier.${id}`), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: muted,
									children: [" — ", t(`tier.${id}.desc`)]
								})] })]
							}, id))
						})]
					}),
					status?.tierFellBack === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...muted,
							color: "#c96"
						},
						children: t("state.tierFallback").replace("%s", t(`tier.${status.effectiveTier}`))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: status?.appBridgeAvailable ? t("state.appBridgeOk") : t("state.appBridgeMissing")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							...row,
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: includeSessions,
							onChange: (e) => setIncludeSessions(e.target.checked)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("field.sessions"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: muted,
							children: [" — ", t("field.sessions.desc")]
						})] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							...row,
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: encrypt,
							onChange: (e) => setEncrypt(e.target.checked)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("field.encrypt"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: muted,
							children: [" — ", t("field.encrypt.desc")]
						})] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 600,
							marginTop: 4
						},
						children: t("trigger.label")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: label,
								children: t("trigger.interval")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: {
									...input,
									maxWidth: 120
								},
								type: "number",
								min: 0,
								value: intervalMinutes,
								onChange: (e) => setIntervalMinutes(Number(e.target.value) || 0)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: muted,
								children: t("trigger.interval.hint")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							...row,
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: onStartup,
							onChange: (e) => setOnStartup(e.target.checked)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("trigger.startup") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("trigger.manual")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: busy,
								onClick: () => void save(),
								children: t("action.save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: busy,
								onClick: () => void test(),
								children: t("action.test")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: busy || status?.run.running === true,
								onClick: () => void syncNow(),
								children: t("action.syncNow")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: busy,
								onClick: () => void run(async () => {
									setReport(await api.trigger("push", password === "" ? void 0 : password));
									await refresh();
								}),
								children: t("action.push")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: busy,
								onClick: () => void run(async () => {
									setReport(await api.trigger("pull", password === "" ? void 0 : password));
									await refresh();
								}),
								children: t("action.pull")
							})
						]
					}),
					status?.run.running === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("state.running")
					}),
					note !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...muted,
							color: "#6a6"
						},
						children: note
					}),
					error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...muted,
							color: "#c66"
						},
						children: error
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: box,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 600 },
						children: t("state.history")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: muted,
						children: [
							t("state.lastSync"),
							": ",
							status?.lastSyncedHash === "" ? t("state.neverSynced") : status?.lastSyncedHash.slice(0, 12)
						]
					}),
					(status?.history.length ?? 0) === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("state.history.empty")
					}),
					(status?.history ?? []).map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...row,
							justifyContent: "space-between"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { fontFamily: "monospace" },
								children: c.hash.slice(0, 12)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: muted,
								children: new Date(c.at).toLocaleString()
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: muted,
								children: c.file
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: muted,
								children: c.tier
							})
						]
					}, c.hash)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: busy,
							onClick: () => void run(async () => {
								setReport(await api.trigger("pull", password === "" ? void 0 : password));
								await refresh();
							}),
							children: t("action.pull")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: busy,
							onClick: () => void run(async () => {
								await api.forget();
								setNote(t("state.saved"));
								await refresh();
							}),
							children: t("action.forget")
						})]
					})
				]
			}),
			report?.outcome === "conflict" && report.conflict !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: {
					...box,
					borderColor: "#c96"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 600 },
						children: t("state.conflict.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("state.conflict.desc")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: muted,
						children: [
							"upstream ",
							report.conflict.remoteHash.slice(0, 12),
							report.conflict.remoteAt === "" ? "" : ` @ ${new Date(report.conflict.remoteAt).toLocaleString()}`,
							" · ",
							"local ",
							report.conflict.localHash.slice(0, 12)
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: busy,
							onClick: () => void resolve("local"),
							children: t("action.keepLocal")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: busy,
							onClick: () => void resolve("remote"),
							children: t("action.keepRemote")
						})]
					})
				]
			}),
			report !== null && report.outcome !== "conflict" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: box,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 600 },
						children: t("log.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: report.message }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: {
							...muted,
							whiteSpace: "pre-wrap",
							margin: 0,
							maxHeight: 200,
							overflow: "auto"
						},
						children: report.lines.join("\n")
					})
				]
			})
		]
	});
}
//#endregion
//#region src/client/locales.ts
/**
* 云备份设置页的文案（zh 主源 / en 镜像）。
*
* 键名分类前缀：`section.` 页面级、`field.` 表单字段、`tier.` 备份档位、
* `action.` 按钮、`state.` 状态与结果。新增键必须两份都加（type 会强制）。
*/
const zh = {
	"section.label": "云备份",
	"section.desc": "把完整备份同步到 WebDAV：定时/启动后/手动触发，按内容哈希去重，冲突时停下来问你。",
	"field.url": "WebDAV 地址",
	"field.url.hint": "例如 https://dav.example.com/dav",
	"field.username": "用户名",
	"field.password": "密码",
	"field.password.keep": "留空 = 保持已保存的密码",
	"field.remoteDir": "远端子目录",
	"field.remoteDir.hint": "默认 dsh-folk（与配置管理器的 dsh-config-manager/ 并列）",
	"tier.label": "备份档位",
	"tier.dsh-only": "仅 DSH 数据",
	"tier.dsh-only.desc": "配置、插件清单、MCP、技能、工作区等。不含凭据原文。",
	"tier.dsh-vault": "仅 DSH 数据（含 vault）",
	"tier.dsh-vault.desc": "上面那些 + 凭据原文。必须加密。",
	"tier.app-only": "仅软件数据",
	"tier.app-only.desc": "App 设置与外观（背景/字体/音乐/音效）。可能不含 DSH 数据。",
	"tier.app-dsh": "软件数据 + DSH 数据",
	"tier.app-dsh.desc": "两边都带。这是 App 里「备份」的默认档位。",
	"tier.app-dsh-vault": "软件数据 + DSH 数据（含 vault）",
	"tier.app-dsh-vault.desc": "最全的一档，含凭据原文。必须加密。",
	"field.sessions": "包含会话记录",
	"field.sessions.desc": "对话历史会显著增大包体积，默认不含。",
	"field.encrypt": "加密备份包",
	"field.encrypt.desc": "含 vault 的档位必须开启；口令在「立即执行」时填写。",
	"trigger.label": "触发方式",
	"trigger.interval": "定时间隔（分钟）",
	"trigger.interval.hint": "0 = 关闭定时触发",
	"trigger.startup": "DSH 启动后自动同步一次",
	"trigger.manual": "允许手动触发（始终可用）",
	"action.save": "保存",
	"action.test": "测试连接",
	"action.syncNow": "立即同步",
	"action.push": "只上传",
	"action.pull": "只从上游恢复",
	"action.forget": "忘记上游锚点",
	"action.keepLocal": "用本机覆盖上游",
	"action.keepRemote": "用上游覆盖本机",
	"state.loading": "读取中…",
	"state.saved": "已保存。",
	"state.testOk": "连接正常。",
	"state.passwordSet": "已配置",
	"state.passwordUnset": "未配置",
	"state.neverSynced": "从未同步",
	"state.lastSync": "上次同步",
	"state.appBridgeOk": "宿主 App 软件数据接口：可用",
	"state.appBridgeMissing": "宿主 App 软件数据接口：不可用（含软件数据的档位会自动回退）",
	"state.managerMissing": "未检测到 dsh-config-manager：DSH 数据无法备份/恢复，请先安装并启用它。",
	"state.tierFallback": "当前档位会回退为：%s",
	"state.running": "同步进行中…",
	"state.history": "提交历史（本机记录）",
	"state.history.empty": "还没有提交记录。",
	"state.conflict.title": "上游与本机都有改动",
	"state.conflict.desc": "为避免覆盖你的数据，这里不会自动合并：请选择保留哪一边。",
	"log.title": "最近一次运行的日志"
};
const en = {
	"section.label": "Cloud backup",
	"section.desc": "Sync a full backup to WebDAV: timer, on DSH startup, or manual. Hash-based dedup, and conflicts stop and ask you.",
	"field.url": "WebDAV URL",
	"field.url.hint": "e.g. https://dav.example.com/dav",
	"field.username": "Username",
	"field.password": "Password",
	"field.password.keep": "Leave empty to keep the saved password",
	"field.remoteDir": "Remote subdirectory",
	"field.remoteDir.hint": "Defaults to dsh-folk (sits beside the config manager’s dsh-config-manager/)",
	"tier.label": "Backup tier",
	"tier.dsh-only": "DSH data only",
	"tier.dsh-only.desc": "Settings, plugin list, MCP, skills, workspaces, etc. No credential values.",
	"tier.dsh-vault": "DSH data only (with vault)",
	"tier.dsh-vault.desc": "The above plus credential values. Encryption is required.",
	"tier.app-only": "App data only",
	"tier.app-only.desc": "App settings and appearance (background, font, music, sound). May exclude DSH data.",
	"tier.app-dsh": "App data + DSH data",
	"tier.app-dsh.desc": "Both sides. This is the default tier in the app’s backup screen.",
	"tier.app-dsh-vault": "App data + DSH data (with vault)",
	"tier.app-dsh-vault.desc": "The most complete tier, including credential values. Encryption is required.",
	"field.sessions": "Include conversation sessions",
	"field.sessions.desc": "Session history makes the archive much larger; excluded by default.",
	"field.encrypt": "Encrypt the archive",
	"field.encrypt.desc": "Required for vault tiers; the password is entered when you sync now.",
	"trigger.label": "Triggers",
	"trigger.interval": "Timer interval (minutes)",
	"trigger.interval.hint": "0 disables the timer",
	"trigger.startup": "Sync once after DSH starts",
	"trigger.manual": "Allow manual triggering (always available)",
	"action.save": "Save",
	"action.test": "Test connection",
	"action.syncNow": "Sync now",
	"action.push": "Upload only",
	"action.pull": "Restore from upstream",
	"action.forget": "Forget upstream anchor",
	"action.keepLocal": "Keep local, overwrite upstream",
	"action.keepRemote": "Take upstream, overwrite local",
	"state.loading": "Loading…",
	"state.saved": "Saved.",
	"state.testOk": "Connection OK.",
	"state.passwordSet": "configured",
	"state.passwordUnset": "not configured",
	"state.neverSynced": "never synced",
	"state.lastSync": "Last sync",
	"state.appBridgeOk": "Host app data interface: available",
	"state.appBridgeMissing": "Host app data interface: unavailable (app-data tiers will fall back automatically)",
	"state.managerMissing": "dsh-config-manager not detected: DSH data cannot be backed up or restored. Install and enable it first.",
	"state.tierFallback": "Current tier will fall back to: %s",
	"state.running": "A sync is running…",
	"state.history": "Commit history (local record)",
	"state.history.empty": "No commits yet.",
	"state.conflict.title": "Both upstream and this device changed",
	"state.conflict.desc": "Nothing is merged automatically — choose which side to keep.",
	"log.title": "Last run log"
};
//#endregion
//#region src/client/index.ts
/** 本插件拥有的 locale namespace。 */
const NS = "folk-cloud";
/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
const inject = ["slots", "locale"];
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "folk-cloud: dictionaries");
	const t = ctx.locale.bind(NS);
	const api = new CloudApi();
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "folk-cloud",
		order: 61,
		label: () => t("section.label"),
		locale: NS,
		inject: () => ({
			api,
			t
		})
	}, CloudSection));
}
//#endregion
exports.apply = apply;
exports.inject = inject;


		return module.exports;
	}
});
//# sourceMappingURL=client.js.map