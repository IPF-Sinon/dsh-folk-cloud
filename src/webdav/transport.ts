/**
 * WebDAV 传输层（本插件自建，不依赖 dsh-config-manager 的 sync 通道）。
 *
 * ## 为什么自建
 *
 * dsh-config-manager 的 WebDAV sync 传的是「DSH 分区 JSON 快照」（`<id>.json` + `index.json`），
 * 它**没有**「一个任意文件」的概念 —— 而云备份要搬的是整包 zip（可能含 App 数据与外观）。
 * 硬塞进去只会把两边的模型都拧坏，所以这里自己实现一套最小可用的 WebDAV 客户端，
 * 只做四件事：列目录（PROPFIND）、建目录（MKCOL）、传文件（PUT）、取文件（GET），外加 DELETE。
 *
 * ## 远端布局
 *
 * ```
 * <url>/<remoteDir>/index.json          —— manifest（上游提交历史）
 * <url>/<remoteDir>/<file>              —— 整包备份
 * ```
 * 与 dsh-config-manager 的 `<url>/dsh-config-manager/` **同级但不同目录**，互不覆盖。
 *
 * ## 安全与健壮性（照抄 dsh-config-manager 踩过的坑）
 *
 * - **口令只从注入的凭据提供者取**，绝不进 URL、不进日志；
 * - 错误信息里的响应体统一脱敏（口令出现即替换）；
 * - 重定向：自动跟随 301/302/303/307/308（网盘 WebDAV 会把 GET 302 到预签名 CDN 直链），
 *   **跨源跳转剥离 Authorization**（预签名 URL 不该收到 Basic 凭据），上限 5 跳；
 * - 单请求超时（默认 120s：慢速网盘上传大包常超过 30s）；
 * - 二进制安全：PUT/GET 收发 Buffer，不经过字符串。
 */
import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';

/** 默认单请求超时：网盘限速时上传一个几百 MB 的包 30s 远远不够。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 错误消息里保留的响应体长度上限（防超大/二进制响应撑爆消息）。 */
const ERR_BODY_MAX = 500;

/** 自动跟随的重定向状态码。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 重定向最大跳数（防 302 循环拖死请求）。 */
export const MAX_REDIRECTS = 5;

/** 遇到限流/暂时不可用时自动退避重试的状态码。 */
const RETRY_STATUSES = new Set([429, 503]);

/** 限流退避：最大重试次数与每次等待上限（自建 WebDAV 如 OpenList、坚果云都可能返回 429）。 */
export const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_WAIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 解析 `Retry-After`：可能是秒数，也可能是 HTTP 日期。解析不出就退回指数退避。
 * 返回等待毫秒数，夹到 [RETRY_BASE_MS, RETRY_MAX_WAIT_MS]。
 */
function retryDelayMs(retryAfter: string | undefined, attempt: number): number {
  const fallback = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_WAIT_MS);
  if (retryAfter === undefined || retryAfter.trim() === '') return fallback;
  const secs = Number(retryAfter.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(Math.max(secs * 1000, RETRY_BASE_MS), RETRY_MAX_WAIT_MS);
  const at = Date.parse(retryAfter);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), RETRY_BASE_MS), RETRY_MAX_WAIT_MS);
  return fallback;
}

const REDACTED = '[REDACTED]';

/** 口令提供者：口令只在请求发出的一瞬间被读出来用，不缓存、不入配置。 */
export interface WebdavCredentialProvider {
  getPassword(): Promise<string>;
}

export interface WebdavResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  /** body 按 UTF-8 解码的文本（PROPFIND 的 XML 用）。 */
  text(): string;
}

export interface WebdavRequestOptions {
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  /** 上传进度回调（已交给 socket 的字节数）。仅 PUT 大包时有意义。 */
  onUploadProgress?: (sent: number) => void;
}

/** 可注入的请求实现（测试用；默认走 node:http/https 流式请求）。 */
export type WebdavRequestFn = (
  method: string,
  url: string,
  options: WebdavRequestOptions,
  auth: string | null,
) => Promise<WebdavResponse>;

export interface WebdavTransportOptions {
  /** WebDAV 根地址（http/https，不含凭据）。 */
  baseUrl: string;
  username: string;
  credentials: WebdavCredentialProvider;
  /** 单请求超时（ms）。 */
  timeoutMs?: number;
  request?: WebdavRequestFn;
}

export class WebdavError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'WebdavError';
    this.status = status;
  }
}

/** 把响应体里可能出现的口令换成占位符（错误消息会被展示、写日志）。 */
function redact(text: string, password: string): string {
  if (password === '') return text;
  return text.split(password).join(REDACTED).slice(0, ERR_BODY_MAX);
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 默认请求实现：node:http/https，支持任意方法、准确 Content-Length、自动跟随重定向、429/503 退避重试。 */
const defaultRequest: WebdavRequestFn = async (method, url, options, auth) => {
  // 外层：限流/暂时不可用（429/503）时按 Retry-After 退避重试整轮请求（含重定向）。
  for (let attempt = 0; ; attempt++) {
    let currentMethod = method;
    let currentUrl = url;
    let currentHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    let currentBody = options.body;
    if (auth !== null) currentHeaders['authorization'] = auth;

    let res: WebdavResponse;
    for (let redirects = 0; ; redirects++) {
      res = await rawRequest(currentMethod, currentUrl, currentHeaders, currentBody, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.onUploadProgress);
      if (!REDIRECT_STATUSES.has(res.status) || res.headers['location'] === undefined) break;
      if (redirects >= MAX_REDIRECTS) {
        throw new WebdavError(`重定向超过 ${MAX_REDIRECTS} 跳`, res.status);
      }
      const next = new URL(res.headers['location'] as string, currentUrl);
      const sameOrigin = next.origin === new URL(currentUrl).origin;
      // 303 一律降级 GET：CDN 直链不接受带体的 PUT；顺带丢掉 body
      if (res.status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = { ...currentHeaders };
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
      }
      if (!sameOrigin) {
        // 跨源（预签名 CDN 直链）：不把 Basic 凭据转发给第三方域
        currentHeaders = { ...currentHeaders };
        delete currentHeaders['authorization'];
      }
      currentUrl = next.toString();
    }

    // 被限流/暂时不可用：还有重试额度就按 Retry-After 退避后重来（PUT/GET/PROPFIND/DELETE 皆可安全重试）。
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res.headers['retry-after'], attempt));
      continue;
    }
    return res;
  }
};

function rawRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
  onUploadProgress?: (sent: number) => void,
): Promise<WebdavResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(body.length) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') flat[k.toLowerCase()] = v;
            else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') flat[k.toLowerCase()] = v[0];
          }
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: flat,
            body: buffer,
            text: () => buffer.toString('utf8'),
          });
        });
      },
    );
    // 超时 = 彻底放弃这次请求（不重试：重试由上层决定，传输层只负责如实报错）
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    if (body !== undefined) {
      // 分块写 + 背压等待：一次性 req.write(整包) 在大包时既占内存峰值又拿不到进度。
      // 按 256KB 一段写，写不动（背压）就等 drain 再继续 —— 进度大致跟着实际发送节奏走。
      const CHUNK = 256 * 1024;
      let off = 0;
      const pump = (): void => {
        while (off < body.length) {
          const end = Math.min(off + CHUNK, body.length);
          const ok = req.write(body.subarray(off, end));
          off = end;
          onUploadProgress?.(off);
          if (!ok) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    } else {
      req.end();
    }
  });
}

/** 远端目录里的一项。 */
export interface RemoteItem {
  /** 文件名（href 解码后的最后一段）。 */
  name: string;
  /** 原样 href（仍百分号编码，可直接用于请求）。 */
  path: string;
  size: number;
  mtimeMs: number;
  isCollection: boolean;
}

export class WebdavTransport {
  private readonly base: string;
  private readonly username: string;
  private readonly credentials: WebdavCredentialProvider;
  private readonly timeoutMs: number;
  private readonly request: WebdavRequestFn;

  constructor(options: WebdavTransportOptions) {
    const base = normalizeBase(options.baseUrl);
    if (base === '') throw new WebdavError('WebDAV 地址为空');
    this.base = base;
    this.username = options.username;
    this.credentials = options.credentials;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request = options.request ?? defaultRequest;
  }


  /** 绝对 URL：base + 可选段 + 可选文件名。段里的每部分各自编码。 */
  url(...segments: string[]): string {
    const tail = segments
      .filter((s) => s !== '')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return tail === '' ? `${this.base}/` : `${this.base}/${tail}`;
  }

  /** 发一次请求；非 2xx 直接抛（错误消息里带状态码与脱敏后的响应体）。 */
  private async send(method: string, url: string, options: WebdavRequestOptions = {}): Promise<WebdavResponse> {
    const password = await this.credentials.getPassword();
    const auth = `Basic ${Buffer.from(`${this.username}:${password}`, 'utf8').toString('base64')}`;
    return this.request(method, url, { timeoutMs: this.timeoutMs, ...options }, auth);
  }

  /**
   * 组装错误消息：状态码 + 脱敏后的响应体。
   *
   * 响应体常含服务端提示（坚果云的「目录不存在」、Nextcloud 的 XML 错误），对用户有用；
   * 但它也可能回显请求内容 —— 所以先脱敏再截断。
   */
  private fail(prefix: string, res: WebdavResponse, password: string): never {
    const detail = redact(res.text(), password);
    throw new WebdavError(`${prefix}：HTTP ${res.status} ${detail}`.trim(), res.status);
  }

  /**
   * 列出某个目录（PROPFIND Depth: 1）。
   *
   * 服务端差异很大（Nextcloud / 坚果云 / Alist 的 href 形式与命名空间前缀都不同），所以：
   * - 比较标签名时统一去掉命名空间前缀并转小写；
   * - href 可能是绝对 URL 也可能是绝对路径，两种都归一化；
   * - 目录**不存在**（404）返回空列表而不是抛错：调用方据此决定「要不要建目录」，
   *   把「不存在」与「连不上」混成一个错误会让首次同步的报错变得没法读。
   */
  async list(dir: string): Promise<RemoteItem[]> {
    const password = await this.credentials.getPassword();
    const url = dir.trim() === '' ? `${this.base}/` : this.url(dir);
    const res = await this.send('PROPFIND', url, {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:propfind xmlns:D="DAV:"><D:prop>' +
          '<D:displayname/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/>' +
          '</D:prop></D:propfind>',
        'utf8',
      ),
    });
    if (res.status === 404) return [];
    // 207 Multi-Status 是正常返回；有些服务端直接 200；405/501 = 不支持 PROPFIND
    if (res.status !== 207 && !res.ok) {
      if (res.status === 405 || res.status === 501) {
        throw new WebdavError('该服务不支持 PROPFIND（可能需要开启 WebDAV 或换一个地址）', res.status);
      }
      this.fail('列目录失败', res, password);
    }
    return parsePropfind(res.text(), url);
  }

  /** 建目录（已存在则静默成功）。第 1 段建完再建第 2 段 —— MKCOL 不做递归。 */
  async ensureDir(dir: string): Promise<void> {
    const segs = dir.split('/').filter((s) => s !== '');
    let current = '';
    for (const seg of segs) {
      current = current === '' ? seg : `${current}/${seg}`;
      const url = this.url(...current.split('/'));
      const res = await this.send('MKCOL', url);
      // 201 建好了；405 = 已存在（绝大多数服务端这样回）；301/302 表示已存在
      if (res.status === 201 || res.status === 405 || res.status === 301 || res.status === 302) continue;
      if (!res.ok) {
        const password = await this.credentials.getPassword();
        this.fail(`建目录 ${current} 失败`, res, password);
      }
    }
  }

  /** 读一个文件；404 返回 null（调用方区分「没有」与「坏了」）。 */
  async get(file: string): Promise<Buffer | null> {
    const res = await this.send('GET', this.url(file));
    if (res.status === 404) return null;
    if (!res.ok) {
      const password = await this.credentials.getPassword();
      this.fail(`下载 ${file} 失败`, res, password);
    }
    return res.body;
  }

  /** 覆盖式写入一个文件。[onProgress] 报已发送字节数（大包上传进度条用）。 */
  async put(
    file: string,
    body: Buffer,
    contentType = 'application/octet-stream',
    onProgress?: (sent: number) => void,
  ): Promise<void> {
    const res = await this.send('PUT', this.url(file), {
      headers: { 'content-type': contentType },
      body,
      ...(onProgress === undefined ? {} : { onUploadProgress: onProgress }),
    });
    // 201 = 新建，204 = 覆盖成功，200 = 有些服务端这么回
    if (!res.ok) {
      const password = await this.credentials.getPassword();
      this.fail(`上传 ${file} 失败`, res, password);
    }
  }

  /** 删文件；404 视为已删（幂等）。 */
  async delete(file: string): Promise<void> {
    const res = await this.send('DELETE', this.url(file));
    if (res.status === 404) return;
    if (!res.ok) {
      const password = await this.credentials.getPassword();
      this.fail(`删除 ${file} 失败`, res, password);
    }
  }

  /** 探活：能成功列出远端根目录就算通。 */
  async test(): Promise<void> {
    await this.list('');
  }
}

/**
 * 解析 PROPFIND 的 207 响应。
 *
 * 手写解析而**不引 XML 库**：只关心四个字段，且这里必须对命名空间前缀不敏感
 * （`D:response` / `d:response` / 无前缀都合法）—— 用 DOM 解析反而要多带一个依赖。
 * 状态机刻意保持简单：只在 `<response>` 内部取值，遇到该标签结束就输出一项。
 */
export function parsePropfind(xml: string, dirUrl: string): RemoteItem[] {
  const out: RemoteItem[] = [];
  // 先按 <response> 切块：比逐标签状态机好读，也对格式差异更宽容
  const blocks = xml.split(/<(?:[A-Za-z0-9_-]+:)?response\b/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/<\/(?:[A-Za-z0-9_-]+:)?response\s*>/i)[0] ?? block;
    const href = tagText(body, 'href');
    if (href === '') continue;
    const isCollection = /<(?:[A-Za-z0-9_-]+:)?collection\s*\/?>/i.test(body);
    const decoded = decodeHref(href);
    // JS 的 trimEnd() 不接受参数（这点与 Kotlin 的 trimEnd(chars) 不同），去掉末尾斜杠要用正则
    const name = decoded.replace(/\/+$/, '').split('/').pop() ?? '';
    if (name === '' || isSameDir(href, dirUrl)) continue;
    out.push({
      name,
      path: href,
      size: Number(tagText(body, 'getcontentlength')) || 0,
      mtimeMs: parseHttpDate(tagText(body, 'getlastmodified')),
      isCollection,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 取某个标签的文本（忽略命名空间前缀与属性）。 */
function tagText(xml: string, name: string): string {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}\\s*>`, 'i');
  const m = re.exec(xml);
  return m?.[1]?.trim() ?? '';
}

/** href 与请求目录是不是同一个（服务器会返回目录自身那一条）。 */
export function isSameDir(href: string, dirUrl: string): boolean {
  const a = normalizeHref(href);
  const b = normalizeHref(dirUrl);
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** href → 绝对路径（绝对 URL 取 path，绝对路径原样，相对路径原样返回交给调用方）。 */
export function normalizeHref(href: string): string {
  const h = href.trim();
  try {
    return new URL(h).pathname;
  } catch {
    return h;
  }
}

/**
 * href 的百分号解码。
 *
 * 先把 `+` 换成 `%2B` 再交给 decodeURIComponent：后者不管 `+`，但有些服务端会把
 * 文件名里的空格编码成 `+`，而字面量 `+` 必须保住 —— 统一按「`+` 是字面量」处理，
 * 与 dsh-config-manager 的 WebDAV 实现保持同一口径。
 */
export function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href.replace(/\+/g, '%2B'));
  } catch {
    return href;
  }
}

/** RFC 1123 的 `Wed, 21 Oct 2015 07:28:00 GMT`；也认 ISO 形式。解析不了返回 0。 */
export function parseHttpDate(text: string): number {
  if (text.trim() === '') return 0;
  const rfc = Date.parse(text);
  if (!Number.isNaN(rfc)) return rfc;
  return 0;
}

