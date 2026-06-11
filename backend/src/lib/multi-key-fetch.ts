import { logger } from "./logger.js";

// Keep a rotating index for each set of keys to avoid repeatedly burning the first key.
// The key is the original comma-separated string, the value is the current index.
const keyIndexCache = new Map<string, number>();

// Track known-bad keys per key-string with TTL (5 minutes).
// Prevents wasting requests on keys that recently returned 401/403.
const BAD_KEY_TTL_MS = 5 * 60 * 1000;
const badKeyCache = new Map<string, Map<string, number>>();

function isKeyBad(cacheKey: string, key: string): boolean {
  const bad = badKeyCache.get(cacheKey);
  if (!bad) return false;
  const ts = bad.get(key);
  if (!ts) return false;
  if (Date.now() - ts > BAD_KEY_TTL_MS) {
    bad.delete(key);
    if (bad.size === 0) badKeyCache.delete(cacheKey);
    return false;
  }
  return true;
}

function markKeyBad(cacheKey: string, key: string): void {
  if (!badKeyCache.has(cacheKey)) badKeyCache.set(cacheKey, new Map());
  badKeyCache.get(cacheKey)!.set(key, Date.now());
}

function markKeyGood(cacheKey: string, key: string): void {
  badKeyCache.get(cacheKey)?.delete(key);
}

/**
 * A drop-in replacement for the global fetch function that intercepts
 * requests with multiple API keys (comma-separated in headers) and 
 * automatically retries on rate limits (429) or quota errors (401/402/403).
 *
 * Proactive bad-key tracking:
 * - Keys that returned 401/403 are marked bad for 5 minutes
 * - On the next request, known-bad keys are skipped entirely
 * - On success, a key is cleared from the bad set
 */
export async function multiKeyFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // We need to extract headers. Depending on how fetch was called,
  // headers could be in `init` or inside the `Request` object.
  let requestHeaders = new Headers();
  let isRequestObj = false;
  let requestObj: Request | null = null;

  if (input instanceof Request) {
    isRequestObj = true;
    requestObj = input;
    input.headers.forEach((value, key) => requestHeaders.set(key, value));
  }
  if (init?.headers) {
    const initHeaders = new Headers(init.headers);
    initHeaders.forEach((value, key) => requestHeaders.set(key, value));
  }

  // Look for our specific authorization headers
  const authHeader = requestHeaders.get("Authorization");
  const xApiKeyHeader = requestHeaders.get("x-api-key");
  const subscriptionTokenHeader = requestHeaders.get("X-Subscription-Token");

  let keyString = "";
  let headerName = "";
  let prefix = "";

  let queryParamKey = false;
  let urlObj: URL | null = null;

  try {
    urlObj = new URL(typeof input === "string" ? input : (input instanceof Request ? input.url : input.toString()));
  } catch {}

  const urlKey = urlObj?.searchParams.get("key");

  if (authHeader && authHeader.includes(",")) {
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      prefix = authHeader.slice(0, 7);
      keyString = authHeader.slice(7);
    } else {
      keyString = authHeader;
    }
    headerName = "Authorization";
  } else if (xApiKeyHeader && xApiKeyHeader.includes(",")) {
    keyString = xApiKeyHeader;
    headerName = "x-api-key";
  } else if (subscriptionTokenHeader && subscriptionTokenHeader.includes(",")) {
    keyString = subscriptionTokenHeader;
    headerName = "X-Subscription-Token";
  } else if (urlKey && urlKey.includes(",")) {
    keyString = urlKey;
    queryParamKey = true;
  } else {
    // No comma-separated keys found, proceed normally.
    return fetch(input, init);
  }

  const keys = keyString.split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length <= 1) {
    return fetch(input, init);
  }

  const cacheKey = keyString;
  let currentIndex = keyIndexCache.get(cacheKey) ?? 0;

  // Build the try-order: start from currentIndex, skip known-bad keys
  const tryOrder: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const candidate = keys[(currentIndex + i) % keys.length];
    if (!isKeyBad(cacheKey, candidate)) {
      tryOrder.push(candidate);
    }
  }
  // If all keys are bad, try them all anyway (TTL might expire during retries)
  if (tryOrder.length === 0) {
    for (let i = 0; i < keys.length; i++) {
      tryOrder.push(keys[(currentIndex + i) % keys.length]);
    }
  }

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < tryOrder.length; attempt++) {
    const activeKey = tryOrder[attempt];
    
    // Update headers or URL with the single active key
    const newHeaders = new Headers(requestHeaders);
    if (!queryParamKey) {
      newHeaders.set(headerName, prefix + activeKey);
    }
    
    let fetchPromise: Promise<Response>;

    if (queryParamKey && urlObj) {
      urlObj.searchParams.set("key", activeKey);
      if (isRequestObj && requestObj) {
        const clonedReq = requestObj.clone();
        const newInit: RequestInit = {
          method: clonedReq.method,
          headers: newHeaders,
          body: clonedReq.body ? await clonedReq.clone().arrayBuffer() : null,
          redirect: clonedReq.redirect,
          signal: init?.signal ?? clonedReq.signal,
        };
        fetchPromise = fetch(urlObj.toString(), newInit);
      } else {
        const newInit: RequestInit = { ...init, headers: newHeaders };
        fetchPromise = fetch(urlObj.toString(), newInit);
      }
    } else {
      if (isRequestObj && requestObj) {
        const clonedReq = requestObj.clone();
        const newInit: RequestInit = {
          method: clonedReq.method,
          headers: newHeaders,
          body: clonedReq.body ? await clonedReq.clone().arrayBuffer() : null,
          redirect: clonedReq.redirect,
          signal: init?.signal ?? clonedReq.signal,
        };
        fetchPromise = fetch(clonedReq.url, newInit);
      } else {
        const newInit: RequestInit = { ...init, headers: newHeaders };
        fetchPromise = fetch(input, newInit);
      }
    }

    try {
      lastResponse = await fetchPromise;
    } catch (networkErr) {
      // If the abort signal was already triggered (timeout / pipeline cancel), don't retry.
      if ((init as RequestInit)?.signal?.aborted) {
        if (attempt === tryOrder.length - 1) throw networkErr;
        break;
      }
      const maskedKey = `...${activeKey.slice(-4)}`;
      logger.warn(`[multi-key-fetch] Key ${maskedKey} network error: ${(networkErr as Error)?.message ?? networkErr}. Rolling over to next key. (${attempt + 1}/${tryOrder.length})`);
      markKeyBad(cacheKey, activeKey);
      if (attempt === tryOrder.length - 1) throw networkErr;
      continue;
    }

    // Retry on auth/rate-limit errors AND server errors
    const retryableStatus = [401, 402, 403, 408, 429, 500, 502, 503, 504, 529].includes(lastResponse.status);
    if (retryableStatus) {
      if ((init as RequestInit)?.signal?.aborted) break;
      const maskedKey = `...${activeKey.slice(-4)}`;
      logger.warn(`[multi-key-fetch] Key ${maskedKey} got ${lastResponse.status}. Rolling over to next key. (${attempt + 1}/${tryOrder.length})`);
      // Mark auth failures as bad keys (they won't magically fix themselves in seconds)
      if (lastResponse.status === 401 || lastResponse.status === 403) {
        markKeyBad(cacheKey, activeKey);
      }
      continue;
    }

    // Success or non-retryable error — update cache and mark key as good
    const originalIndex = keys.indexOf(activeKey);
    keyIndexCache.set(cacheKey, originalIndex >= 0 ? originalIndex : (currentIndex + attempt) % keys.length);
    if (lastResponse.ok) {
      markKeyGood(cacheKey, activeKey);
    }
    return lastResponse;
  }

  // All keys failed — bump index so we don't hammer the exact same sequence
  keyIndexCache.set(cacheKey, (currentIndex + 1) % keys.length);
  return lastResponse!;
}
