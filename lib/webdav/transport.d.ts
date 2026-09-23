import { Buffer } from 'node:buffer';
/** 默认单请求超时：网盘限速时上传一个几百 MB 的包 30s 远远不够。 */
export declare const DEFAULT_TIMEOUT_MS = 120000;
/** 重定向最大跳数（防 302 循环拖死请求）。 */
export declare const MAX_REDIRECTS = 5;
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
}
/** 可注入的请求实现（测试用；默认走 node:http/https 流式请求）。 */
export type WebdavRequestFn = (method: string, url: string, options: WebdavRequestOptions, auth: string | null) => Promise<WebdavResponse>;
export interface WebdavTransportOptions {
    /** WebDAV 根地址（http/https，不含凭据）。 */
    baseUrl: string;
    username: string;
    credentials: WebdavCredentialProvider;
    /** 单请求超时（ms）。 */
    timeoutMs?: number;
    request?: WebdavRequestFn;
}
export declare class WebdavError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
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
export declare class WebdavTransport {
    private readonly base;
    private readonly username;
    private readonly credentials;
    private readonly timeoutMs;
    private readonly request;
    constructor(options: WebdavTransportOptions);
    /** 绝对 URL：base + 可选段 + 可选文件名。段里的每部分各自编码。 */
    url(...segments: string[]): string;
    /** 发一次请求；非 2xx 直接抛（错误消息里带状态码与脱敏后的响应体）。 */
    private send;
    /**
     * 组装错误消息：状态码 + 脱敏后的响应体。
     *
     * 响应体常含服务端提示（坚果云的「目录不存在」、Nextcloud 的 XML 错误），对用户有用；
     * 但它也可能回显请求内容 —— 所以先脱敏再截断。
     */
    private fail;
    /**
     * 列出某个目录（PROPFIND Depth: 1）。
     *
     * 服务端差异很大（Nextcloud / 坚果云 / Alist 的 href 形式与命名空间前缀都不同），所以：
     * - 比较标签名时统一去掉命名空间前缀并转小写；
     * - href 可能是绝对 URL 也可能是绝对路径，两种都归一化；
     * - 目录**不存在**（404）返回空列表而不是抛错：调用方据此决定「要不要建目录」，
     *   把「不存在」与「连不上」混成一个错误会让首次同步的报错变得没法读。
     */
    list(dir: string): Promise<RemoteItem[]>;
    /** 建目录（已存在则静默成功）。第 1 段建完再建第 2 段 —— MKCOL 不做递归。 */
    ensureDir(dir: string): Promise<void>;
    /** 读一个文件；404 返回 null（调用方区分「没有」与「坏了」）。 */
    get(file: string): Promise<Buffer | null>;
    /** 覆盖式写入一个文件。 */
    put(file: string, body: Buffer, contentType?: string): Promise<void>;
    /** 删文件；404 视为已删（幂等）。 */
    delete(file: string): Promise<void>;
    /** 探活：能成功列出远端根目录就算通。 */
    test(): Promise<void>;
}
/**
 * 解析 PROPFIND 的 207 响应。
 *
 * 手写解析而**不引 XML 库**：只关心四个字段，且这里必须对命名空间前缀不敏感
 * （`D:response` / `d:response` / 无前缀都合法）—— 用 DOM 解析反而要多带一个依赖。
 * 状态机刻意保持简单：只在 `<response>` 内部取值，遇到该标签结束就输出一项。
 */
export declare function parsePropfind(xml: string, dirUrl: string): RemoteItem[];
/** href 与请求目录是不是同一个（服务器会返回目录自身那一条）。 */
export declare function isSameDir(href: string, dirUrl: string): boolean;
/** href → 绝对路径（绝对 URL 取 path，绝对路径原样，相对路径原样返回交给调用方）。 */
export declare function normalizeHref(href: string): string;
/**
 * href 的百分号解码。
 *
 * 先把 `+` 换成 `%2B` 再交给 decodeURIComponent：后者不管 `+`，但有些服务端会把
 * 文件名里的空格编码成 `+`，而字面量 `+` 必须保住 —— 统一按「`+` 是字面量」处理，
 * 与 dsh-config-manager 的 WebDAV 实现保持同一口径。
 */
export declare function decodeHref(href: string): string;
/** RFC 1123 的 `Wed, 21 Oct 2015 07:28:00 GMT`；也认 ISO 形式。解析不了返回 0。 */
export declare function parseHttpDate(text: string): number;
