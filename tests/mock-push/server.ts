// Mock de service Web Push (harnais de TEST uniquement) — HTTPS :3443
// Accepte n'importe quel POST et répond 201 (comme FCM/Mozilla autopush).
Bun.serve({
  port: 3443,
  tls: {
    cert: Bun.file("/tmp/mock-cert.pem"),
    key: Bun.file("/tmp/mock-key.pem"),
  },
  async fetch(req) {
    const body = await req.arrayBuffer().catch(() => null)
    console.log(
      `[mock-push] ${req.method} ${req.url} — ${body?.byteLength ?? 0} octets chiffrés, TTL=${req.headers.get("ttl")}, Content-Encoding=${req.headers.get("content-encoding")}`
    )
    return new Response(null, { status: 201 })
  },
})
console.log("[mock-push] HTTPS prêt sur https://localhost:3443")
