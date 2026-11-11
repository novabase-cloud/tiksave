import { corsHeaders } from "../utils/cors.js";

// Global isolate in-memory cache
let inMemoryBackend = null;

const CACHE_KEY_URL = "https://api-tiksave.internal/teller/backend";
const DEFAULT_SECRET = "tiksave-teller-secret-2026";
const MAX_BACKEND_AGE_MS = 25 * 60 * 1000; // 25 minutes validity window

export async function handleTeller(request, env, ctx) {
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // --- GET /teller : return active backend URL ---
  if (method === "GET") {
    let backend = inMemoryBackend;

    // Check Cloudflare Cache API if memory is empty
    if (!backend) {
      try {
        const cache = caches.default;
        const cacheResp = await cache.match(CACHE_KEY_URL);
        if (cacheResp) {
          backend = await cacheResp.json();
          inMemoryBackend = backend;
        }
      } catch (err) {
        console.warn("[teller-cache-err]", err);
      }
    }

    // Check KV if bound and still no backend
    if (!backend && env?.TELLER_KV) {
      try {
        const kvVal = await env.TELLER_KV.get("active_backend");
        if (kvVal) {
          backend = JSON.parse(kvVal);
          inMemoryBackend = backend;
        }
      } catch (err) {
        console.warn("[teller-kv-err]", err);
      }
    }

    const now = Date.now();
    const isAlive = backend && backend.url && (now - (backend.updatedAt || 0) < MAX_BACKEND_AGE_MS);

    if (isAlive) {
      const ageSeconds = Math.round((now - backend.updatedAt) / 1000);
      return new Response(
        JSON.stringify({
          ok: true,
          active: true,
          url: backend.url,
          updatedAt: backend.updatedAt,
          ageSeconds: ageSeconds,
          runner: backend.runner || "unknown",
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders(),
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: false,
        active: false,
        url: null,
        message: "No active runner backend available. Please start or wait for the GitHub Action runner.",
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }

  // --- POST /teller : register active backend URL ---
  if (method === "POST") {
    const authHeader = request.headers.get("Authorization") || "";
    const expectedSecret = env?.TELLER_SECRET || DEFAULT_SECRET;

    if (authHeader !== `Bearer ${expectedSecret}`) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid teller secret token" }),
        {
          status: 401,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        }
      );
    }

    let payload = {};
    try {
      payload = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON payload" }),
        { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const rawUrl = (payload.url || "").trim();
    if (!rawUrl || !rawUrl.startsWith("http")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'url' field" }),
        { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const cleanUrl = rawUrl.replace(/\/+$/, "");
    inMemoryBackend = {
      url: cleanUrl,
      updatedAt: Date.now(),
      runner: payload.runner || "unknown",
    };

    // Store into Cloudflare Cache API for edge-wide availability
    const cacheKey = new Request(CACHE_KEY_URL);
    const cacheResp = new Response(JSON.stringify(inMemoryBackend), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "max-age=1500", // 25 minutes
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, cacheResp));

    // Store into KV if bound
    if (env?.TELLER_KV) {
      ctx.waitUntil(
        env.TELLER_KV.put("active_backend", JSON.stringify(inMemoryBackend), {
          expirationTtl: 1500,
        })
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        registered: cleanUrl,
        updatedAt: inMemoryBackend.updatedAt,
      }),
      {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  }

  return new Response(
    JSON.stringify({ error: "Method not allowed. Use GET or POST." }),
    {
      status: 405,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    }
  );
}
