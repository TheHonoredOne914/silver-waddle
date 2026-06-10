import { logger } from "./logger.js";

// Keep a rotating index for each set of keys to avoid repeatedly burning the first key.
// The key is the original comma-separated string, the value is the current index.
const keyIndexCache = new Map<string, number>();

/**
 * A drop-in replacement for the global fetch function that intercepts
 * requests with multiple API keys (comma-separated in headers) and 
 * automatically retries on rate limits (429) or quota errors (401/402/403).
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

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const activeKey = keys[(currentIndex + attempt) % keys.length];
    
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
        // Reconstruct the request to avoid "body stream already read" if we need to retry
        // Note: If it's a stream body we might not be able to clone it easily, 
        // but usually SDKs pass stringified JSON which clones fine.
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
      // Network-level failure (DNS, connection reset, timeout, etc.) — rotate to next key
      const maskedKey = `...${activeKey.slice(-4)}`;
      logger.warn(`[multi-key-fetch] Key ${maskedKey} network error: ${(networkErr as Error)?.message ?? networkErr}. Rolling over to next key. (${attempt + 1}/${keys.length})`);
      if (attempt === keys.length - 1) throw networkErr; // all keys exhausted, re-throw
      continue;
    }

    // Retry on auth/rate-limit errors AND server errors — any non-success response
    // that indicates the key or server is temporarily broken
    const retryableStatus = [401, 402, 403, 408, 429, 500, 502, 503, 504, 529].includes(lastResponse.status);
    if (retryableStatus) {
      const maskedKey = `...${activeKey.slice(-4)}`;
      logger.warn(`[multi-key-fetch] Key ${maskedKey} got ${lastResponse.status}. Rolling over to next key. (${attempt + 1}/${keys.length})`);
      continue;
    }

    // Success or non-retryable error (like 400 Bad Request)
    // Update cache so next time we start at the key that worked
    keyIndexCache.set(cacheKey, (currentIndex + attempt) % keys.length);
    return lastResponse;
  }

  // If all keys failed, bump the index anyway so we don't hammer the exact same sequence next time
  keyIndexCache.set(cacheKey, (currentIndex + 1) % keys.length);
  return lastResponse!;
}
