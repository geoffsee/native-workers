export interface Env {
  APP_LABEL: string;
  COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const current = (await this.state.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.state.storage.put("count", next);
    return new Response(String(next));
  }
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const id = env.COUNTER.idFromName("main");
    const stub = env.COUNTER.get(id);
    const counterResponse = await stub.fetch("https://counter/increment");
    const count = await counterResponse.text();

    return Response.json({
      scenario: "01-vars-and-durable-object",
      appLabel: env.APP_LABEL,
      count,
    });
  },
};
