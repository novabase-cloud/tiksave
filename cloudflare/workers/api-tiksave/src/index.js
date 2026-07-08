import { handleProxy } from "./proxy.js";
import { handleRecommendation } from "./recommendation.js";
import { handleFileTree } from "./filetree.js";
import { corsHeaders } from "../utils/cors.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const path = url.pathname;

    // /proxy/* → forward to Hugging Face
    if (path.startsWith("/proxy")) {
      url.pathname = path.slice("/proxy".length) || "/";
      return handleProxy(request, url);
    }

    // /recommendation → recommendation handler
    if (path === "/recommendation" || path.startsWith("/recommendation/")) {
      return handleRecommendation(request, url, ctx);
    }

    // /filetree/* → recursive file tree lister
    if (path.startsWith("/filetree/")) {
      url.pathname = path.slice("/filetree".length);
      return handleFileTree(url, ctx);
    }

    // Unknown section
    return new Response(
      JSON.stringify({
        error: "Unknown section",
        message: `No handler for path: ${path}`,
        sections: ["/proxy/*", "/recommendation", "/filetree/*"],
      }),
      {
        status: 404,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  },
};
