import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // imapflow/mailparser : CJS natifs avec dépendances dynamiques — chargés
  // tels quels depuis node_modules côté serveur (jamais bundlés).
  serverExternalPackages: ["imapflow", "mailparser", "nodemailer"],
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
