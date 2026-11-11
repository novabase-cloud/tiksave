import { corsHeaders } from "../utils/cors.js";

// In-memory fallback if KV namespace is not yet bound
let _memoryBackend = null;
const CACHE_KEY = "https://api-tiksave.internal/teller-active-backend";
const DEFAULT_SECRET = "tiksave-teller-secret-2026";
const MAX_STALE_MS = 20 * 60 * 1000; // 20 minutes max stale threshold

export async function handleTeller(request, url, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const defaultHeaders = {
    ...corsHeaders(),
    "Content-Type": "application/json",
  };

  const path = url.pathname;

  // 1. REGISTER / HEARTBEAT: POST /teller, POST /teller/register, POST /teller/heartbeat
  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: defaultHeaders }
      );
    }

    const secret =
      body.secret ||
      request.headers.get("x-teller-secret") ||
      (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

    const expectedSecret = env.TELLER_SECRET || DEFAULT_SECRET;

    if (!secret || secret !== expectedSecret) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: invalid teller secret" }),
        { status: 401, headers: defaultHeaders }
      );
    }

    const backendUrl = (body.url || "").trim().replace(/\/+$/, "");
    if (!backendUrl || !backendUrl.startsWith("http")) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid backend URL" }),
        { status: 400, headers: defaultHeaders }
      );
    }

    const now = Date.now();
    const payload = {
      url: backendUrl,
      updatedAt: now,
      expiresAt: now + 15 * 60 * 1000,
    };

    // Update in-memory
    _memoryBackend = payload;

    // Persist in Cloudflare KV if bound
    if (env.TELLER_KV) {
      try {
        await env.TELLER_KV.put("active_backend", JSON.stringify(payload), {
          expirationTtl: 1200, // 20 minutes
        });
      } catch (err) {
        console.error("Failed to write to TELLER_KV:", err);
      }
    }

    // Persist in Edge Cache
    if (caches.default && ctx) {
      try {
        const cacheResp = new Response(JSON.stringify(payload), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=900",
          },
        });
        ctx.waitUntil(caches.default.put(CACHE_KEY, cacheResp));
      } catch (err) {
        console.error("Failed to write to caches.default:", err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Runner registered successfully",
        ...payload,
      }),
      { status: 200, headers: defaultHeaders }
    );
  }

  // 2. DISCOVERY: GET /teller, GET /teller/url
  if (request.method === "GET") {
    let data = null;

    // Check Cloudflare KV first
    if (env.TELLER_KV) {
      try {
        const raw = await env.TELLER_KV.get("active_backend");
        if (raw) data = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to read from TELLER_KV:", e);
      }
    }

    // Check Edge Cache
    if (!data && caches.default) {
      try {
        const hit = await caches.default.match(CACHE_KEY);
        if (hit) data = await hit.json();
      } catch {}
    }

    // Check in-memory fallback
    if (!data && _memoryBackend) {
      data = _memoryBackend;
    }

    // Validate freshness
    if (data && data.url) {
      const age = Date.now() - (data.updatedAt || 0);
      if (age < MAX_STALE_MS) {
        return new Response(
          JSON.stringify({
            ok: true,
            url: data.url,
            updatedAt: data.updatedAt,
            ageMs: age,
          }),
          {
            status: 200,
            headers: {
              ...defaultHeaders,
              "Cache-Control": "public, max-age=30", // client caches for 30s
            },
          }
        );
      }
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: "no_active_backend",
        message: "No active GitHub Actions runner tunnel registered or runner expired",
      }),
      {
        status: 503,
        headers: {
          ...defaultHeaders,
          "Cache-Control": "no-store",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    { status: 405, headers: defaultHeaders }
  );
}
