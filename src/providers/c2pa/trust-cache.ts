// Persistent cache for trust-list fetches. MV3 kills idle service workers
// after ~30s, so "fetch once per worker lifetime" would mean refetching the
// ~285 KB of trust lists many times per browsing session. The Cache API is
// available in service workers without any manifest permission (unlike
// chrome.storage), which keeps the extension's zero-permission posture.
//
// Freshness: entries newer than the TTL are served without touching the
// network; stale entries are refetched, but a stale entry still beats a
// failed refetch — losing connectivity should not disable trust
// verification that worked yesterday. See DECISIONS.md.

const TRUST_CACHE_NAME = "trueorigin-trust-v1";
const FETCHED_AT_HEADER = "x-trueorigin-fetched-at";

/** Upstream serves these with s-maxage of 12h; a day keeps us at most one
 * signer-onboarding cycle behind. */
export const TRUST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function openTrustCache(): Promise<Cache | undefined> {
  // Absent in Node (unit tests) and guarded against storage errors — the
  // cache is an optimization, never a requirement.
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open(TRUST_CACHE_NAME);
  } catch {
    return undefined;
  }
}

function isFresh(cached: Response): boolean {
  const fetchedAt = Number(cached.headers.get(FETCHED_AT_HEADER));
  return (
    Number.isFinite(fetchedAt) && Date.now() - fetchedAt < TRUST_CACHE_TTL_MS
  );
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Trust list fetch failed: ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new Error(
      `Trust list response from ${url} exceeds ${maxBytes} bytes`,
    );
  }
  return text;
}

export async function cachedFetchText(
  url: string,
  maxBytes: number,
): Promise<string> {
  const cache = await openTrustCache();
  const cached = await cache?.match(url);
  if (cached && isFresh(cached)) {
    return cached.text();
  }
  let text: string;
  try {
    text = await fetchText(url, maxBytes);
  } catch (error) {
    // A stale trust list beats a broken one — losing connectivity should
    // not disable verification that worked yesterday.
    if (cached) return cached.text();
    throw error;
  }
  try {
    await cache?.put(
      url,
      new Response(text, {
        headers: {
          "content-type": "text/plain",
          [FETCHED_AT_HEADER]: String(Date.now()),
        },
      }),
    );
  } catch {
    // Cache writes are best-effort; the fetched text is still good.
  }
  return text;
}
