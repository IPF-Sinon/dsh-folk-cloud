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
	/**
	* 问「当前外观主题打进包有多大」。
	*
	* 走插件自己的 `/theme` 路由（客户端够不到宿主 App 的回环桥，只能由插件代问）。
	* 拿不到就返回 null，界面按「含主题」处理。
	*/
	async themeInfo(force = false) {
		const res = await fetch(`/api/dsh-folk-cloud/theme${force ? "?force=1" : ""}`);
		if (!res.ok) return null;
		try {
			const parsed = await res.json();
			return typeof parsed.sizeBytes === "number" ? parsed : null;
		} catch {
			return null;
		}
	}
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
	/** 恢复一个指定的历史版本（用那一版覆盖本机，锚点对齐到这一版）。 */
	async restore(hash, password) {
		return readJson(await fetch("/api/dsh-folk-cloud/restore", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				hash,
				...password === void 0 ? {} : { password }
			})
		}));
	}
	/** 从云端永久删除一个历史版本（删文件 + 摘清单）。 */
	async deleteCommit(hash) {
		return readJson(await fetch("/api/dsh-folk-cloud/delete-commit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ hash })
		}));
	}
	/** 忘记上游锚点（不删远端任何东西）。 */
	async forget() {
		await readJson(await fetch("/api/dsh-folk-cloud/forget", { method: "POST" }));
	}
};
//#endregion
//#region src/client/SyncOverlay.tsx
/**
* 同步进度遮罩：阻挡操作 + 阶段步骤 + 上传进度条 + 实时日志 + 动画。
*
* 纯展示组件：所有数据由调用方从 status.run（或本次手动动作）传进来。备份/恢复/同步/删除
* 都复用它，样式走内联 style（这个插件不带 CSS 打包链）。动画用一个只注入一次的 <style>。
*/
/** 一次动作会经过的阶段顺序（用来画步骤条 + 判断当前走到第几步）。 */
const PHASE_FLOW = {
	push: [
		"preparing",
		"producing",
		"uploading",
		"finalizing",
		"done"
	],
	pull: [
		"preparing",
		"downloading",
		"restoring",
		"done"
	],
	delete: ["deleting", "done"]
};
/** 按当前 phase 猜它属于哪条流程（决定步骤条画哪几步）。 */
function flowFor(phase) {
	if (phase === "downloading" || phase === "restoring") return PHASE_FLOW["pull"];
	if (phase === "deleting") return PHASE_FLOW["delete"];
	return PHASE_FLOW["push"];
}
function humanBytes(n) {
	if (n <= 0) return "0 B";
	const u = [
		"B",
		"KB",
		"MB",
		"GB"
	];
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
function SyncOverlay(props) {
	const { title, phase, uploaded, total, lines, phaseLabel, hint, bytesLabel } = props;
	const flow = flowFor(phase);
	const activeIdx = Math.max(0, flow.indexOf(phase));
	const determinate = total > 0 && phase === "uploading";
	const percent = determinate ? Math.min(100, Math.round(uploaded / total * 100)) : 0;
	const dark = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
	const surface = dark ? "#1e1e1e" : "#ffffff";
	const fg = dark ? "#f0f0f0" : "#1a1a1a";
	const border = dark ? "#3a3a3a" : "#d9d9d9";
	const track = dark ? "#3a3a3a" : "#e4e4e7";
	const logBg = dark ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.05)";
	const primary = "#3b82f6";
	const logRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		const el = logRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lines.length]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			position: "fixed",
			inset: 0,
			background: "rgba(0,0,0,0.5)",
			backdropFilter: "blur(2px)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 9999,
			animation: "dfc-fade 0.15s ease-out"
		},
		onClick: (e) => e.stopPropagation(),
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: KEYFRAMES }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				width: "min(440px, 92vw)",
				display: "flex",
				flexDirection: "column",
				gap: 14,
				padding: 20,
				borderRadius: 14,
				border: `1px solid ${border}`,
				background: surface,
				color: fg,
				boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
				animation: "dfc-pop 0.2s ease-out"
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 10
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
						width: 16,
						height: 16,
						borderRadius: "50%",
						border: `2px solid ${primary}`,
						borderTopColor: "transparent",
						display: "inline-block",
						animation: "dfc-spin 0.8s linear infinite",
						flex: "0 0 auto"
					} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontWeight: 600,
							fontSize: 15
						},
						children: title
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						gap: 6
					},
					children: flow.filter((p) => p !== "done").map((p, i) => {
						const done = i < activeIdx;
						const active = i === activeIdx;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								flex: 1,
								display: "flex",
								flexDirection: "column",
								gap: 4
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
								height: 4,
								borderRadius: 2,
								background: done || active ? primary : track,
								opacity: done ? .6 : 1,
								transition: "background 0.3s"
							} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									textAlign: "center",
									opacity: active ? 1 : .5,
									fontWeight: active ? 600 : 400
								},
								children: phaseLabel(p)
							})]
						}, p);
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						position: "relative",
						height: 8,
						borderRadius: 4,
						overflow: "hidden",
						background: track
					},
					children: determinate ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
						position: "absolute",
						left: 0,
						top: 0,
						bottom: 0,
						width: `${percent}%`,
						background: primary,
						borderRadius: 4,
						transition: "width 0.2s ease-out"
					} }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
						position: "absolute",
						top: 0,
						bottom: 0,
						width: "40%",
						background: primary,
						borderRadius: 4,
						animation: "dfc-indeterminate 1.1s ease-in-out infinite"
					} })
				}),
				determinate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 12,
						opacity: .75,
						textAlign: "right",
						marginTop: -8
					},
					children: bytesLabel(humanBytes(uploaded), humanBytes(total), percent)
				}),
				lines.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					ref: logRef,
					style: {
						margin: 0,
						maxHeight: 140,
						overflow: "auto",
						fontSize: 11,
						lineHeight: 1.5,
						opacity: .85,
						whiteSpace: "pre-wrap",
						background: logBg,
						borderRadius: 8,
						padding: 10
					},
					children: lines.join("\n")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 12,
						opacity: .65
					},
					children: hint
				})
			]
		})]
	});
}
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
/**
* 含**软件数据**的档位 —— 只有这些档位里才有外观主题，主题开关也只在这几档下显示与检测。
* 与宿主 App 的 scopeForTier（app-only / app-dsh / app-dsh-vault）保持同一口径。
*/
const TIERS_WITH_APP = [
	"app-only",
	"app-dsh",
	"app-dsh-vault"
];
/** 字节数换成人类可读（与宿主日志里的写法一致，便于对照）。 */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
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
	const [busyLabel, setBusyLabel] = (0, react.useState)("");
	const [report, setReport] = (0, react.useState)(null);
	const [url, setUrl] = (0, react.useState)("");
	const [username, setUsername] = (0, react.useState)("");
	const [password, setPassword] = (0, react.useState)("");
	const [encryptPassword, setEncryptPassword] = (0, react.useState)("");
	const [remoteDir, setRemoteDir] = (0, react.useState)("dsh-folk");
	const [tier, setTier] = (0, react.useState)("app-dsh");
	const [includeSessions, setIncludeSessions] = (0, react.useState)(false);
	/**
	* 是否把外观主题打进包。**undefined = 自动**（按宿主报的主题包大小定，超过 5MB 就不含）。
	* 只有用户拨过开关才会有值，这样换主题后默认值能一直跟上。
	*/
	const [includeTheme, setIncludeTheme] = (0, react.useState)(void 0);
	/** 宿主 App 量出来的主题包信息；null = 还没拿到（检测中或桥不可用）。 */
	const [themeSize, setThemeSize] = (0, react.useState)(null);
	const [themeChecking, setThemeChecking] = (0, react.useState)(false);
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
			setIncludeTheme(s.includeTheme);
			setEncrypt(s.encrypt);
			setIntervalMinutes(s.trigger.intervalMinutes);
			setOnStartup(s.trigger.onStartup);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [api]);
	const pollStatus = (0, react.useCallback)(async () => {
		try {
			setStatus(await api.status());
		} catch {}
	}, [api]);
	(0, react.useEffect)(() => {
		refresh();
	}, [refresh]);
	/**
	* 主题包大小只在「档位含软件数据 + App 补包接口可用」时检测 —— 与开关的显示条件完全一致。
	*
	* 默认档位（app-dsh）就含软件数据，所以进页面就会检测一次并按大小定出默认值（需求里那句
	* 「默认配置时也检测一遍进行自动选择」）；换成不含软件数据的档位就不检测、也不显示。
	* 失败（桥不可用/老版本 App）保持 null，界面按「含主题」处理，不替用户把主题排除掉。
	*/
	(0, react.useEffect)(() => {
		if (!(TIERS_WITH_APP.includes(tier) && status?.appBridgeAvailable === true) || themeSize !== null || themeChecking) return;
		let cancelled = false;
		setThemeChecking(true);
		(async () => {
			const info = await api.themeInfo();
			if (cancelled) return;
			setThemeSize(info === null ? null : {
				sizeBytes: info.sizeBytes,
				limitBytes: info.limitBytes,
				defaultInclude: info.defaultInclude
			});
			setThemeChecking(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [
		api,
		tier,
		status?.appBridgeAvailable,
		themeSize,
		themeChecking
	]);
	(0, react.useEffect)(() => {
		const timer = setInterval(() => {
			pollStatus();
		}, 1500);
		return () => clearInterval(timer);
	}, [pollStatus]);
	/** 统一的「跑一件事」包装：忙碌标记 + 进度弹窗文案 + 错误/结果归位。 */
	const run = async (fn, label = "") => {
		setBusy(true);
		setBusyLabel(label);
		setError("");
		setNote("");
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
			setBusyLabel("");
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
			...includeTheme === void 0 ? {} : { includeTheme },
			encrypt,
			...encryptPassword === "" ? {} : { encryptPassword },
			trigger: {
				intervalMinutes,
				onStartup
			}
		});
		setPassword("");
		setEncryptPassword("");
		setNote(t("state.saved"));
		await refresh();
	}, t("action.save"));
	const test = () => run(async () => {
		await api.test(url, username, password);
		setNote(t("state.testOk"));
	}, t("action.test"));
	const syncNow = () => run(async () => {
		const r = await api.trigger("auto", password === "" ? void 0 : password);
		setReport(r);
		await refresh();
	}, t("action.syncNow"));
	const resolve = (keep) => run(async () => {
		const r = await api.resolve(keep, password === "" ? void 0 : password);
		setReport(r);
		await refresh();
	}, keep === "local" ? t("action.keepLocal") : t("action.keepRemote"));
	/** 恢复某个历史版本：用那一版覆盖本机（会先弹确认，避免误点）。 */
	const restore = (hash) => run(async () => {
		const r = await api.restore(hash, password === "" ? void 0 : password);
		setReport(r);
		await refresh();
	}, t("action.restoreThis"));
	/** 从云端永久删除某个历史版本（会先弹确认，破坏性）。 */
	const remove = (hash) => run(async () => {
		const r = await api.deleteCommit(hash);
		setReport(r);
		await refresh();
	}, t("action.deleteThis"));
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
									alignItems: "flex-start",
									cursor: "pointer"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "radio",
									checked: tier === id,
									onChange: () => setTier(id)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										display: "flex",
										flexDirection: "column"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t(`tier.${id}`), "："] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: muted,
										children: t(`tier.${id}.desc`)
									})]
								})]
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
					TIERS_WITH_APP.includes(tier) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...row,
									gap: 6
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: includeTheme ?? themeSize?.defaultInclude ?? true,
									onChange: (e) => setIncludeTheme(e.target.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									t("field.theme"),
									includeTheme === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: muted,
										children: [
											"（",
											t("state.themeAuto"),
											"）"
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: muted,
										children: [" — ", t("field.theme.desc")]
									})
								] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: muted,
								children: themeChecking ? t("state.themeChecking") : themeSize === null ? t("state.themeUnknown") : t("state.themeSize").replace("%s", formatBytes(themeSize.sizeBytes)).replace("%l", formatBytes(themeSize.limitBytes))
							}),
							themeSize !== null && !themeSize.defaultInclude && (includeTheme ?? themeSize.defaultInclude) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									...muted,
									color: "#c96"
								},
								children: t("state.themeTooBig")
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: label,
							children: t("field.encryptPassword")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: input,
							type: "password",
							value: encryptPassword,
							placeholder: `${status?.encryptPasswordConfigured ? t("state.passwordSet") : t("state.passwordUnset")} · ${t("field.encryptPassword.keep")}`,
							onChange: (e) => setEncryptPassword(e.target.value)
						})]
					}),
					encrypt && status?.encryptPasswordConfigured === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...muted,
							color: "#c96"
						},
						children: t("field.encryptPassword.needed")
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
								}, t("action.push")),
								children: t("action.push")
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
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 6
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: {
										...button,
										borderColor: "#a55",
										color: "#e88"
									},
									disabled: busy || status?.run.running === true,
									onClick: () => {
										if (typeof window !== "undefined" && !window.confirm(t("confirm.delete").replace("%s", c.hash.slice(0, 12)))) return;
										remove(c.hash);
									},
									children: t("action.deleteThis")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									disabled: busy || status?.run.running === true,
									onClick: () => {
										if (typeof window !== "undefined" && !window.confirm(t("confirm.restore").replace("%s", c.hash.slice(0, 12)))) return;
										restore(c.hash);
									},
									children: t("action.restoreThis")
								})]
							})
						]
					}, c.hash)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: row,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: busy,
							onClick: () => void run(async () => {
								await api.forget();
								setNote(t("state.saved"));
								await refresh();
							}),
							children: t("action.forget")
						})
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
			}),
			(busy || status?.run.running === true) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SyncOverlay, {
				title: busyLabel !== "" ? busyLabel : t("state.running"),
				phase: status?.run.phase ?? "preparing",
				uploaded: status?.run.uploaded ?? 0,
				total: status?.run.total ?? 0,
				lines: status?.run.lines ?? [],
				phaseLabel: (p) => t(`phase.${p}`),
				hint: t("state.busyHint"),
				bytesLabel: (u, tot, pct) => t("progress.bytes").replace("%a", u).replace("%b", tot).replace("%p", String(pct))
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
	"field.theme": "包含应用主题",
	"field.theme.desc": "把外观（背景/字体/音乐/音效/导航图标）一起备份，主题包大了会明显拖慢同步。",
	"field.sessions": "包含会话记录",
	"field.sessions.desc": "对话历史会显著增大包体积，默认不含。",
	"field.encrypt": "加密备份包",
	"field.encrypt.desc": "含 vault 的档位必须开启。加密口令在下方填写并保存，定时/启动后的自动备份也用它。",
	"field.encryptPassword": "备份加密口令",
	"field.encryptPassword.keep": "留空 = 保持已保存的加密口令",
	"field.encryptPassword.needed": "已开启加密但未设加密口令：请在此填写并保存，否则备份会失败（绝不会静默产出未加密的包）。",
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
	"action.restoreThis": "恢复此版本",
	"action.deleteThis": "删除",
	"action.forget": "忘记上游锚点",
	"action.keepLocal": "用本机覆盖上游",
	"action.keepRemote": "用上游覆盖本机",
	"confirm.restore": "确定用历史版本 %s 覆盖本机吗？当前内容会被这一版替换。",
	"confirm.delete": "确定从云端永久删除历史版本 %s 吗？该备份文件会被删除，不可恢复。",
	"phase.preparing": "准备",
	"phase.producing": "出包",
	"phase.uploading": "上传",
	"phase.finalizing": "收尾",
	"phase.downloading": "下载",
	"phase.restoring": "恢复",
	"phase.deleting": "删除",
	"phase.done": "完成",
	"progress.bytes": "已上传 %a / %b（%p%）",
	"state.loading": "读取中…",
	"state.saved": "已保存。",
	"state.testOk": "连接正常。",
	"state.passwordSet": "已配置",
	"state.passwordUnset": "未配置",
	"state.neverSynced": "从未同步",
	"state.lastSync": "上次同步",
	"state.themeAuto": "自动",
	"state.themeChecking": "正在检测主题包大小…",
	"state.themeSize": "当前主题包大小：%s（上限 %l，超过则默认不含）",
	"state.themeUnknown": "检测不到主题包大小（宿主 App 或补包接口不可用），本次按「包含主题」处理。",
	"state.themeTooBig": "主题包超过上限，已默认不包含；确实需要可以手动勾上。",
	"state.appBridgeOk": "宿主 App 软件数据接口：可用",
	"state.appBridgeMissing": "宿主 App 软件数据接口：不可用（含软件数据的档位会自动回退）",
	"state.managerMissing": "未检测到 dsh-config-manager：DSH 数据无法备份/恢复，请先安装并启用它。",
	"state.tierFallback": "当前档位会回退为：%s",
	"state.running": "同步进行中…",
	"state.busyHint": "处理中，请稍候，不要重复操作…",
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
	"field.theme": "Include app theme",
	"field.theme.desc": "Backs up appearance too (background, font, music, sound effects, nav icons). A large theme noticeably slows syncing down.",
	"field.sessions": "Include conversation sessions",
	"field.sessions.desc": "Session history makes the archive much larger; excluded by default.",
	"field.encrypt": "Encrypt the archive",
	"field.encrypt.desc": "Required for vault tiers. Enter and save the encryption password below; scheduled and on-startup backups use it too.",
	"field.encryptPassword": "Backup encryption password",
	"field.encryptPassword.keep": "Leave empty to keep the saved encryption password",
	"field.encryptPassword.needed": "Encryption is on but no encryption password is set: enter and save one here, or backups will fail (they never silently produce an unencrypted archive).",
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
	"action.restoreThis": "Restore this version",
	"action.deleteThis": "Delete",
	"action.forget": "Forget upstream anchor",
	"action.keepLocal": "Keep local, overwrite upstream",
	"action.keepRemote": "Take upstream, overwrite local",
	"confirm.restore": "Overwrite this device with historical version %s? Current contents will be replaced by that version.",
	"confirm.delete": "Permanently delete historical version %s from the cloud? That backup file will be removed and cannot be recovered.",
	"phase.preparing": "Preparing",
	"phase.producing": "Packing",
	"phase.uploading": "Uploading",
	"phase.finalizing": "Finalizing",
	"phase.downloading": "Downloading",
	"phase.restoring": "Restoring",
	"phase.deleting": "Deleting",
	"phase.done": "Done",
	"progress.bytes": "Uploaded %a / %b (%p%)",
	"state.loading": "Loading…",
	"state.saved": "Saved.",
	"state.testOk": "Connection OK.",
	"state.passwordSet": "configured",
	"state.passwordUnset": "not configured",
	"state.neverSynced": "never synced",
	"state.lastSync": "Last sync",
	"state.themeAuto": "auto",
	"state.themeChecking": "Measuring the theme archive…",
	"state.themeSize": "Current theme archive: %s (limit %l; larger themes are excluded by default)",
	"state.themeUnknown": "Could not measure the theme archive (host app or its data interface unavailable); including the theme this time.",
	"state.themeTooBig": "The theme archive exceeds the limit, so it is excluded by default. Tick the box if you really want it.",
	"state.appBridgeOk": "Host app data interface: available",
	"state.appBridgeMissing": "Host app data interface: unavailable (app-data tiers will fall back automatically)",
	"state.managerMissing": "dsh-config-manager not detected: DSH data cannot be backed up or restored. Install and enable it first.",
	"state.tierFallback": "Current tier will fall back to: %s",
	"state.running": "A sync is running…",
	"state.busyHint": "Working, please wait — don’t click again…",
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