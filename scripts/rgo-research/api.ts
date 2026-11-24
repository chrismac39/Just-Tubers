import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheFile {
  formatVersion: 1;
  entries: Record<string, unknown>;
}

interface CachedHttpClientOptions {
  cachePath: string;
  minIntervalMs?: number;
  wikimediaMinIntervalMs?: number;
  fetchImplementation?: typeof fetch;
}

interface CachedHttpClientGetOptions {
  cacheValue?: (value: unknown) => unknown;
}

interface FetchedResponse {
  status: number;
  statusText: string;
  retryAfter: string | null;
  bodyText: string;
}

const cachePersistInterval = 25;
const wikimediaMaxConcurrentRequests = 3;
const defaultWikimediaMinIntervalMs = 300;
const maxHttpRetries = 2;
const maxWikimediaMaxlagRetries = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestGroup(hostname: string): string {
  if (
    hostname === "wikidata.org" ||
    hostname.endsWith(".wikidata.org") ||
    hostname === "wikipedia.org" ||
    hostname.endsWith(".wikipedia.org")
  ) {
    return "wikimedia";
  }
  return hostname;
}

function isWikimediaApiError(value: unknown, code: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    value.error.code === code
  );
}

function retryAfterMilliseconds(
  retryAfter: string | null,
  fallbackMilliseconds: number,
): number {
  if (retryAfter === null) {
    return fallbackMilliseconds;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMilliseconds = Date.parse(retryAfter);
  if (Number.isFinite(dateMilliseconds)) {
    return Math.max(0, dateMilliseconds - Date.now());
  }
  throw new Error(`Invalid Retry-After header: ${retryAfter}`);
}

function cacheKey(url: string): string {
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.delete("maxlag");
  return parsedUrl.href;
}

export class CachedHttpClient {
  private readonly cachePath: string;
  private readonly minIntervalMs: number;
  private readonly wikimediaMinIntervalMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly cache = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly nextRequestAt = new Map<string, number>();
  private readonly activeRequests = new Map<string, number>();
  private readonly requestQueues = new Map<string, Array<() => void>>();
  private cacheUpdatesSincePersist = 0;
  private loaded = false;

  constructor(options: CachedHttpClientOptions) {
    this.cachePath = options.cachePath;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.wikimediaMinIntervalMs =
      options.wikimediaMinIntervalMs ??
      Math.min(this.minIntervalMs, defaultWikimediaMinIntervalMs);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async get(
    url: string,
    options: CachedHttpClientGetOptions = {},
  ): Promise<unknown> {
    await this.loadCache();
    const key = cacheKey(url);
    const cachedValue = this.cache.get(key);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.getJsonAndCache(url, key, options);
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    }
  }

  async getText(url: string): Promise<string | null> {
    await this.loadCache();
    const key = cacheKey(url);
    const cachedValue = this.cache.get(key);
    if (cachedValue !== undefined) {
      if (cachedValue === null || typeof cachedValue === "string") {
        return cachedValue;
      }
      throw new Error(`Cached response is not text for ${url}`);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      const value = await pending;
      if (value === null || typeof value === "string") {
        return value;
      }
      throw new Error(`Concurrent response was not text for ${url}`);
    }

    const request = this.getTextAndCache(url, key);
    this.inFlight.set(key, request);
    try {
      return await request as string | null;
    } finally {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    }
  }

  async flush(): Promise<void> {
    await this.loadCache();
    if (this.cacheUpdatesSincePersist > 0) {
      await this.persistCache();
    }
  }

  private async getJsonAndCache(
    url: string,
    key: string,
    options: CachedHttpClientGetOptions,
  ): Promise<unknown> {
    let value: unknown;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.request(url, "application/json");
      try {
        value = JSON.parse(response.bodyText) as unknown;
      } catch (error) {
        throw new Error(
          `Response was not valid JSON for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!isWikimediaApiError(value, "maxlag")) {
        break;
      }
      if (attempt >= maxWikimediaMaxlagRetries) {
        throw new Error(`Wikimedia maxlag persisted after retries: ${url}`);
      }
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      const lagSeconds =
        typeof error.lag === "number"
          ? error.lag
          : typeof error.lag === "string"
            ? Number(error.lag)
            : Number.NaN;
      const lagMilliseconds =
        Number.isFinite(lagSeconds) && lagSeconds >= 0
          ? Math.max(lagSeconds * 1000, 5000)
          : 5000;
      const backoffMilliseconds = Math.min(
        60_000,
        5000 * 2 ** attempt,
      );
      const minimumDelay = Math.max(
        lagMilliseconds,
        backoffMilliseconds,
      );
      const maxlagDelay = Math.max(
        minimumDelay,
        retryAfterMilliseconds(response.retryAfter, minimumDelay),
      );
      this.deferRequestGroup("wikimedia", maxlagDelay);
      await delay(maxlagDelay);
    }

    const cachedValue = options.cacheValue ? options.cacheValue(value) : value;
    this.cache.set(key, cachedValue);
    this.cacheUpdatesSincePersist += 1;
    if (this.cacheUpdatesSincePersist >= cachePersistInterval) {
      await this.persistCache();
    }
    return cachedValue;
  }

  private async getTextAndCache(
    url: string,
    key: string,
  ): Promise<string | null> {
    const response = await this.request(
      url,
      "text/html,application/xhtml+xml",
      true,
    );
    const value = response.status === 404 ? null : response.bodyText;
    this.cache.set(key, value);
    this.cacheUpdatesSincePersist += 1;
    if (this.cacheUpdatesSincePersist >= cachePersistInterval) {
      await this.persistCache();
    }
    return value;
  }

  private async acquireRequestSlot(group: string): Promise<void> {
    const active = this.activeRequests.get(group) ?? 0;
    const limit = group === "wikimedia" ? wikimediaMaxConcurrentRequests : 1;
    if (active < limit) {
      this.activeRequests.set(group, active + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.requestQueues.get(group) ?? [];
      queue.push(resolve);
      this.requestQueues.set(group, queue);
    });
  }

  private releaseRequestSlot(group: string): void {
    const queue = this.requestQueues.get(group);
    const next = queue?.shift();
    if (next) {
      next();
      return;
    }
    this.activeRequests.set(group, Math.max(0, (this.activeRequests.get(group) ?? 1) - 1));
  }

  private async scheduleRequestStart(group: string): Promise<void> {
    const interval =
      group === "wikimedia" ? this.wikimediaMinIntervalMs : this.minIntervalMs;
    const now = Date.now();
    const startAt = Math.max(now, this.nextRequestAt.get(group) ?? now);
    this.nextRequestAt.set(group, startAt + interval);
    if (startAt > now) {
      await delay(startAt - now);
    }
  }

  private deferRequestGroup(group: string, milliseconds: number): void {
    this.nextRequestAt.set(
      group,
      Math.max(
        this.nextRequestAt.get(group) ?? 0,
        Date.now() + milliseconds,
      ),
    );
  }

  private async request(
    url: string,
    accept: string,
    allowNotFound = false,
  ): Promise<FetchedResponse> {
    const parsedUrl = new URL(url);
    const group = requestGroup(parsedUrl.hostname);
    const send = () =>
      this.fetchImplementation(url, {
        headers: {
          "User-Agent":
            "JustTubersRgoResearch/0.1",
          Accept: accept,
        },
        signal: AbortSignal.timeout(30_000),
      });

    for (let attempt = 0; ; attempt += 1) {
      await this.acquireRequestSlot(group);
      let response: Response;
      let retryAfter: string | null = null;
      try {
        await this.scheduleRequestStart(group);
        response = await send();
        if (response.status === 429 || response.status === 503) {
          retryAfter = response.headers.get("Retry-After");
        } else {
          if (!response.ok && !(allowNotFound && response.status === 404)) {
            throw new Error(
              `Request failed (${response.status} ${response.statusText}): ${url}`,
            );
          }
          const bodyText =
            allowNotFound && response.status === 404
              ? ""
              : await response.text();
          return {
            status: response.status,
            statusText: response.statusText,
            retryAfter: response.headers.get("Retry-After"),
            bodyText,
          };
        }
      } finally {
        this.releaseRequestSlot(group);
      }

      if (attempt >= maxHttpRetries) {
        throw new Error(
          `Request failed (${response.status} ${response.statusText}) after retries: ${url}`,
        );
      }
      const fallbackDelay = Math.max(
        5000,
        (group === "wikimedia"
          ? this.wikimediaMinIntervalMs
          : this.minIntervalMs) *
          2 ** (attempt + 1),
      );
      await delay(
        retryAfterMilliseconds(
          retryAfter,
          fallbackDelay,
        ),
      );
    }
  }

  private async loadCache(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let contents: string;
    try {
      contents = await readFile(this.cachePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.loaded = true;
        return;
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(contents);
    if (
      !isRecord(parsed) ||
      parsed.formatVersion !== 1 ||
      !isRecord(parsed.entries)
    ) {
      throw new Error(`Invalid RGO research cache format: ${this.cachePath}`);
    }
    for (const [url, value] of Object.entries(parsed.entries)) {
      this.cache.set(url, value);
    }
    this.loaded = true;
  }

  private async persistCache(): Promise<void> {
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const cacheFile: CacheFile = {
      formatVersion: 1,
      entries: Object.fromEntries(this.cache),
    };
    await writeFile(this.cachePath, `${JSON.stringify(cacheFile, null, 2)}\n`);
    this.cacheUpdatesSincePersist = 0;
  }
}
