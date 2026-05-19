export interface Env {
  AUTH: Fetcher;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const authResponse = await env.AUTH.fetch("https://auth.local/check");
    const payload = await authResponse.json();

    return Response.json({
      scenario: "03-service-binding-native-config",
      auth: payload,
    });
  },
};
