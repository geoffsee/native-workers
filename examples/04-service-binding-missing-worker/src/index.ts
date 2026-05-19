export interface Env {
  MISSING: Fetcher;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const response = await env.MISSING.fetch("https://missing.local/");
    return new Response(await response.text());
  },
};
