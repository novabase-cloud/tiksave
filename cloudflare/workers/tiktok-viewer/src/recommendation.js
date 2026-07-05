const HF_BASE = "https://huggingface.co";
const CACHE_TTL = 300;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-requested-with",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), "Content-Type": "application/json" },
  });
}

async function fetchCached(dataUrl, headers, ctx) {
  const cache = caches.default;
  const key = new Request(dataUrl);

  const hit = await cache.match(key);
  if (hit) return hit.json();

  const resp = await fetch(dataUrl, { headers });
  if (!resp.ok) return null;

  const data = await resp.json();
  const cached = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
  ctx.waitUntil(cache.put(key, cached));
  return data;
}

function sortEntries(entries, sort) {
  const s = [...entries];
  switch (sort) {
    case "newests":
    case "newest":
      s.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
      break;
    case "oldests":
    case "oldest":
      s.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
      break;
    case "ascending":
    case "name_asc":
      s.sort((a, b) => a.itemId.localeCompare(b.itemId));
      break;
    case "descending":
    case "name_desc":
      s.sort((a, b) => b.itemId.localeCompare(a.itemId));
      break;
  }
  return s;
}

/**
 * Handle recommendation.json requests with pagination, lookup, and sorting.
 *
 * url       — incoming request URL (contains ?page, ?item, ?sort, ?limit)
 * headers   — cleaned headers with auth token
 * ctx       — execution context for cache waitUntil
 *
 * Returns a Response, or null if no special params (falls through to proxy).
 */
export async function handleRecommendation(url, headers, ctx) {
  const params = url.searchParams;
  const hasPage = params.has("page");
  const hasItem = params.has("item");
  const hasSort = params.has("sort");

  if (!hasPage && !hasItem && !hasSort) return null;

  const dataUrl = `${HF_BASE}${url.pathname}`;
  const data = await fetchCached(dataUrl, headers, ctx);
  if (!data) {
    return json({ error: "Failed to fetch recommendation data", path: url.pathname }, 502);
  }
  if (typeof data !== "object" || data === null) {
    return json({ error: "Invalid recommendation data format", type: typeof data }, 502);
  }

  // ?item — single entry lookup
  if (hasItem) {
    return json({ data: data[params.get("item")] || null });
  }

  // Convert dict to array for sorting/pagination (handle both object & array)
  let entries;
  if (Array.isArray(data)) {
    entries = data.map((entry, i) => ({
      itemId: entry.itemId || entry.id || String(i),
      ...entry,
    }));
  } else {
    entries = Object.entries(data).map(([itemId, entry]) => ({
      itemId,
      ...entry,
    }));
  }
  if (!entries.length) {
    return json({ data: [], total: 0, page: 1, totalPages: 0 });
  }

  // ?sort
  if (hasSort) entries = sortEntries(entries, params.get("sort"));

  // ?page
  if (hasPage) {
    const limit = Math.min(
      parseInt(params.get("limit")) || DEFAULT_LIMIT,
      MAX_LIMIT
    );
    const page = Math.max(1, parseInt(params.get("page")) || 1);
    const total = entries.length;
    const sliced = entries.slice((page - 1) * limit, page * limit);
    return json({
      data: sliced,
      page,
      totalPages: Math.ceil(total / limit),
      total,
    });
  }

  // Only ?sort — return all sorted
  return json({ data: entries, total: entries.length });
}
