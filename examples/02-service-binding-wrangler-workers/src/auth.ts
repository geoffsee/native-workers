export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, source: "ex02-auth-worker" });
  },
};
