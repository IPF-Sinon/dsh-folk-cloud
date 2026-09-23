/**
 * HTTP 工具：回环守卫、JSON 读写。
 *
 * 守卫口径与 dsh-config-manager 完全一致（照抄它的实现，不自己发明一套）：
 * 这些端点会读写备份、下发口令，绝不能从局域网被访问。DSH-Folk 的 web 服务在某些配置下
 * 会监听 0.0.0.0（App 侧为了局域网访问专门 patch 过 startup.js），所以「回环 + 同源」
 * 这道检查不是可选项。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** 请求体上限：本插件的 JSON 请求都很小（配置/触发），1MB 足够且能挡住误用。 */
export declare const MAX_JSON_BODY_BYTES: number;
/**
 * 回环 + 同源守卫。
 *
 * 判据（缺一不可）：
 * 1. TCP 对端是回环地址；
 * 2. Host 头指向回环 / localhost；
 * 3. 不是跨站 Fetch 元数据（`sec-fetch-site: cross-site`）；
 * 4. 带了 Origin 时，其 host 必须与 Host 一致（防 DNS rebinding 与跨站表单）。
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
export declare function writeJson(res: ServerResponse, status: number, body: unknown): void;
/** 读 JSON 体；超限或非法 JSON 返回 undefined（调用方回 400）。 */
export declare function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined>;
/** 取 query 的第一个值（已解码）。 */
export declare function queryParam(url: URL, name: string): string | undefined;
