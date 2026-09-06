"use client";

// Orbit — Rendu du corps HTML d'un email dans une iframe SANDBOX
// ─────────────────────────────────────────────────────────────────────────────
// Défense en profondeur (2e barrière après sanitize-html côté serveur) :
//   • sandbox SANS allow-scripts ni allow-same-origin → aucun script exécutable,
//     aucun accès au DOM parent ;
//   • allow-popups (+ <base target="_blank">) → les liens s'ouvrent en nouvel
//     onglet au lieu de naviguer dans l'iframe ;
//   • style injecté : largeur contrainte, images max 100 %, thème clair/sombre
//     aligné sur le prefers-color-scheme du navigateur.

import { useMemo } from "react"

const IFRAME_DOC = (html: string) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 16px 18px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14.5px;
    line-height: 1.65;
    color: #17203a;
    background: #ffffff;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  img, video { max-width: 100% !important; height: auto; }
  table { max-width: 100%; }
  a { color: #3556c9; }
  pre, code { font-family: ui-monospace, monospace; font-size: 13px; }
  blockquote {
    margin: 8px 0;
    padding: 4px 14px;
    border-left: 3px solid #b9c2d8;
    color: #4a5568;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #dfe3ef; background: #10131d; }
    a { color: #8fb0ff; }
    blockquote { border-left-color: #3d4763; color: #9aa3bd; }
  }
</style>
</head>
<body>${html}</body>
</html>`

/** Corps d'email rendu isolé (iframe sandbox — hauteur fixe, défilement interne). */
export function EmailBodyFrame({ html, className }: { html: string; className?: string }) {
  const srcDoc = useMemo(() => IFRAME_DOC(html), [html])
  return (
    <iframe
      title="Corps de l'email (rendu isolé)"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className={className ?? "h-[420px] w-full rounded-lg border border-border/60 bg-background"}
      loading="lazy"
    />
  )
}
