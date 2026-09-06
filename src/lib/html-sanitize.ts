// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Nettoyage du HTML des emails (sanitize-html) — serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Le HTML des emails est notoirement « sale » : styles inline destructeurs,
// <script>, onclick, iframes de tracking, URL javascript:… On blanchit TOUT
// avant stockage (bodyHtml) — le rendu côté client se fait ensuite dans une
// iframe sandbox, double barrière (défense en profondeur) :
//   1. sanitize-html au moment de la sync (scripts/styles/attributs retirés) ;
//   2. iframe sandbox="allow-popups" au rendu (aucune exécution, aucun accès
//      au DOM parent même si un contenu malveillant passait la première barrière).
//
// Politique : tags de mise en forme + tableaux + images + liens uniquement.
// Attributs réduits au strict minimum. Schémas http/https/mailto/cid (les
// cid: sont réécrits vers /api/emails/attachments/[id] à la lecture du détail).
// ═══════════════════════════════════════════════════════════════════════════

import "server-only"
import sanitizeHtml from "sanitize-html"

/** Taille maximale du HTML stocké (après nettoyage) — 200 Ko. */
const HTML_MAX_CHARS = 200_000

const ALLOWED_TAGS = [
  // Structure & mise en forme
  "a", "b", "blockquote", "br", "caption", "center", "code", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "nl", "ol", "p",
  "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
  // Images (y compris inline via cid:, réécrites à la lecture)
  "img",
]

/**
 * Nettoie le HTML d'un email pour un stockage sûr.
 * Retourne null si le résultat est vide (message sans HTML exploitable).
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (!html || typeof html !== "string") return null

  const cleaned = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "style"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      table: ["width"],
    },
    // width/height inline limités aux dimensions (sanitize-html filtre les
    // valeurs non numériques via allowedSchemesByTag ? Non : style n'est pas
    // dans allowedAttributes sauf img — on retire donc style par défaut).
    allowedSchemes: ["http", "https", "mailto", "cid"],
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    allowProtocolRelative: false,
    // Aucun style/class/id : le CSS des emails casse la mise en page d'Orbit
    transformTags: {
      // Les liens s'ouvrent hors de l'iframe (base target=_blank ajouté au
      // rendu) — target retiré ici, géré par le <base> du document.
      a: (tagName, attribs) => ({ tagName, attribs: { href: attribs.href ?? "#", title: attribs.title } }),
    },
    disallowedTagsMode: "discard",
    // Limites raisonnables
    exclusiveFilter: (frame) =>
      frame.tag === "img" && !frame.attribs?.src, // <img> sans src → déchet
  })

  const trimmed = cleaned.trim()
  if (!trimmed) return null
  return trimmed.slice(0, HTML_MAX_CHARS)
}

/**
 * Extrait un « snippet » (aperçu de liste) à partir du corps texte :
 * espaces blancs réduits, 200 caractères max.
 */
export function snippetFromText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200)
}
