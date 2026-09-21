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
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * 回环 + 同源守卫。
 *
 * 判据（缺一不可）：
 * 1. TCP 对端是回环地址；
 * 2. Host 头指向回环 / localhost；
 * 3. 不是跨站 Fetch 元数据（`sec-fetch-site: cross-site`）；
 * 4. 带了 Origin 时，其 host 必须与 Host 一致（防 DNS rebinding 与跨站表单）。
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

/** 读 JSON 体；超限或非法 JSON 返回 undefined（调用方回 400）。 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 取 query 的第一个值（已解码）。 */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}
