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
export function isLoopbackRequest(request) {
    const address = request.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
        return false;
    const host = request.headers.host;
    if (typeof host !== 'string')
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
        return false;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = request.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
export function writeJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'referrer-policy': 'no-referrer',
    });
    res.end(payload);
}
/** 读 JSON 体；超限或非法 JSON 返回 undefined（调用方回 400）。 */
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk;
        size += buffer.length;
        if (size > MAX_JSON_BODY_BYTES)
            return undefined;
        chunks.push(buffer);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** 取 query 的第一个值（已解码）。 */
export function queryParam(url, name) {
    const value = url.searchParams.get(name);
    return value === null ? undefined : value;
}
//# sourceMappingURL=http.js.map