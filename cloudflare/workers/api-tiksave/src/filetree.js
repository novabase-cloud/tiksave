import { corsHeaders } from "../utils/cors.js";

const HF_API = "https://huggingface.co/api";
const CACHE_TTL = 300;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function parsePath(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return {
    repoType: parts[0],
    owner: parts[1],
    repoName: parts[2],
    subPath: parts.slice(3).join("/"),
  };
}

async function collectAllFiles(token, repoType, repoId, subPath, recursive) {
  let target = `${HF_API}/${repoType}/${repoId}/tree/main/Posts${subPath ? "/" + subPath : ""}${recursive ? "?recursive=1" : ""}`;
  const allFiles = [];

  for (let page = 0; ; page++) {
    const res = await fetch(target, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Cloudflare-Worker-HF-Tree",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return json(
        { error: `HF API ${res.status}`, details: text },
        res.status
      );
    }

    const data = await res.json();
    for (let i = 0; i < data.length; i++) allFiles.push(data[i]);

    const link = res.headers.get("Link");
    if (!link || !link.includes('rel="next"')) break;

    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) break;
    target = m[1];
  }

  return json(allFiles);
}

export async function handleFileTree(url, ctx) {
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing 'token' query parameter" }, 400);
  }

  const path = parsePath(url);
  if (!path) {
    return json(
      {
        error: "Invalid URL format",
        expected: "/filetree/:repoType/:owner/:repoName?token=...",
        example: "/filetree/datasets/Novabase/Tiktok?token=hf_...",
      },
      400
    );
  }

  const recursive = url.searchParams.get("recursive") === "true";
  const repoId = `${path.owner}/${path.repoName}`;
  const cacheKey = `filetree:${repoId}/${path.subPath || ""}:recursive=${recursive}?token=${token.slice(0, 16)}`;

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const result = await collectAllFiles(
    token,
    path.repoType,
    repoId,
    path.subPath,
    recursive
  );

  if (result.status === 200) {
    const cloned = new Response(result.body, {
      status: result.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, cloned.clone()));
    return cloned;
  }

  return result;
}
