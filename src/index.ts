export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Reef", { headers: { "content-type": "text/plain" } });
  },
} satisfies ExportedHandler<Env>;
