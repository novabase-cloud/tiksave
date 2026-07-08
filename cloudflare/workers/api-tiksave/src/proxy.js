import { corsHeaders } from "../utils/cors.js";

const HF_BASE = "https://huggingface.co";

function extractToken(request, url) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }
  return url.searchParams.get("token") || null;
}

export async function handleProxy(request, url) {
  const token = extractToken(request, url);
  url.searchParams.delete("token");
  const cleanQuery = url.searchParams.toString();
  const targetPath = url.pathname + (cleanQuery ? `?${cleanQuery}` : "");
  const targetUrl = `${HF_BASE}${targetPath}`;

  const headers = new Headers(request.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  headers.delete("CF-Connecting-IP");
  headers.delete("CF-IPCountry");
  headers.delete("CF-Ray");
  headers.delete("CF-Visitor");
  headers.delete("CDN-Loop");
  headers.delete("X-Forwarded-For");
  headers.delete("X-Forwarded-Host");
  headers.delete("X-Forwarded-Proto");
  headers.delete("Referer");
  headers.set("Host", "huggingface.co");
  headers.set("Origin", HF_BASE);

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "follow",
    });

    const responseHeaders = new Headers(response.headers);
    const cors = corsHeaders();
    for (const [key, value] of Object.entries(cors)) {
      responseHeaders.set(key, value);
    }
    responseHeaders.delete("Set-Cookie");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy error", message: err.message }),
      {
        status: 502,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  }
}
