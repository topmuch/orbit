import type { NextConfig } from "next";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Next.js — Orbit
// ───────────────────────────────────────────────────────────────────────────
// • output "standalone" : image Docker minimale (server.js + fichiers tracés,
//   cf. Dockerfile racine — étapes deps → builder → migrate → runner).
// • serverExternalPackages : imapflow/mailparser/nodemailer sont des modules
//   CJS natifs à dépendances dynamiques — chargés tels quels depuis
//   node_modules côté serveur (jamais bundlés).
// • En-têtes de sécurité : les en-têtes STRICTS (X-Frame-Options DENY, HSTS,
//   CSP avec frame-ancestors 'none') ne sont émis QU'EN PRODUCTION. En
//   développement (NODE_ENV=development), l'aperçu sandbox s'affiche dans une
//   iframe → DENY/frame-ancestors casserait la prévisualisation. Les en-têtes
//   inoffensifs en iframe restent actifs partout.
//   NB : headers() est évalué au BUILD — l'image Docker construite avec
//   NODE_ENV=production embarque les en-têtes stricts ; next dev garde la
//   variante compatible iframe.
// ═══════════════════════════════════════════════════════════════════════════

const isProduction = process.env.NODE_ENV === "production";

// En-têtes sûrs partout (y compris rendu en iframe — préview sandbox/dev).
const commonHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// En-têtes stricts réservés à la production (consultation directe, HTTPS via
// Caddy — cf. docker/caddy/Caddyfile.prod qui ajoute TLS + compression).
const productionHeaders = [
  // Clicjacking : l'app ne doit JAMAIS être encadrée ailleurs qu'elle-même.
  { key: "X-Frame-Options", value: "DENY" },
  // Surface d'API navigateur réduite au strict nécessaire d'Orbit.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // HTTPS obligatoire 1 an (émis par l'app en plus du TLS frontal Caddy —
  // valable aussi si l'app est servie par un autre frontal un jour).
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // CSP : 'unsafe-inline'/'unsafe-eval' requis par le runtime Next.js (hydratation)
  // ; frame-src data:/blob: pour la lecture sécurisée des emails (iframe
  // sandbox + data-URI des images inline) ; connect-src limité à same-origin
  // (+https pour d'éventuelles images distantes d'emails via le proxy).
  // frame-ancestors 'none' = double verrou du X-Frame-Options.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["imapflow", "mailparser", "nodemailer"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Ne pas révéler la stack (en-tête X-Powered-By).
  poweredByHeader: false,
  // Compression gzip nativement côté serveur (complémentaire de Caddy zstd).
  compress: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: isProduction ? [...commonHeaders, ...productionHeaders] : commonHeaders,
      },
    ];
  },
};

export default nextConfig;
