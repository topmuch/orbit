// Orbit — Génération des icônes PWA (SVG → PNG via sharp)
// Usage : bun scripts/generate-icons.mjs

import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const OUT = "public/icons";

function planetSvg({ size, padding = 0 }) {
  const c = size / 2;
  const planetR = size * (padding ? 0.24 : 0.28);
  const ringRx = planetR * 1.9;
  const ringRy = planetR * 0.62;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241f18"/>
      <stop offset="1" stop-color="#14110c"/>
    </linearGradient>
    <linearGradient id="planet" x1="0.2" y1="0.1" x2="0.9" y2="0.95">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="0.55" stop-color="#f59e0b"/>
      <stop offset="1" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde68a"/>
      <stop offset="0.5" stop-color="#f59e0b"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#f59e0b" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#f59e0b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="url(#bg)"/>
  <circle cx="${c}" cy="${c}" r="${size * (padding ? 0.34 : 0.42)}" fill="url(#glow)"/>
  <!-- étoiles -->
  <circle cx="${size * 0.18}" cy="${size * 0.22}" r="${size * 0.008}" fill="#f4efe4" opacity="0.8"/>
  <circle cx="${size * 0.82}" cy="${size * 0.2}" r="${size * 0.006}" fill="#f4efe4" opacity="0.6"/>
  <circle cx="${size * 0.76}" cy="${size * 0.78}" r="${size * 0.007}" fill="#f4efe4" opacity="0.5"/>
  <circle cx="${size * 0.24}" cy="${size * 0.8}" r="${size * 0.005}" fill="#f4efe4" opacity="0.7"/>
  <!-- planète -->
  <circle cx="${c}" cy="${c}" r="${planetR}" fill="url(#planet)"/>
  <!-- anneau (arrière) -->
  <g transform="rotate(-18 ${c} ${c})">
    <ellipse cx="${c}" cy="${c}" rx="${ringRx}" ry="${ringRy}" fill="none" stroke="url(#ring)" stroke-width="${size * 0.028}" opacity="0.55"/>
  </g>
  <!-- reflet planète -->
  <ellipse cx="${c - planetR * 0.3}" cy="${c - planetR * 0.35}" rx="${planetR * 0.45}" ry="${planetR * 0.3}" fill="#fde68a" opacity="0.35"/>
  <!-- anneau (avant, plus net) -->
  <g transform="rotate(-18 ${c} ${c})">
    <path d="M ${c - ringRx} ${c} A ${ringRx} ${ringRy} 0 0 0 ${c + ringRx} ${c}"
      fill="none" stroke="url(#ring)" stroke-width="${size * 0.026}" stroke-linecap="round"/>
  </g>
  <!-- lune -->
  <circle cx="${c + planetR * 1.45}" cy="${c - planetR * 1.15}" r="${size * 0.028}" fill="#fde68a"/>
</svg>`;
}

// Fond plein pour maskable (pas de coins arrondis — l'OS masque lui-même)
function planetSvgMaskable(size) {
  const c = size / 2;
  const planetR = size * 0.22;
  const ringRx = planetR * 1.75;
  const ringRy = planetR * 0.6;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241f18"/>
      <stop offset="1" stop-color="#14110c"/>
    </linearGradient>
    <linearGradient id="planet" x1="0.2" y1="0.1" x2="0.9" y2="0.95">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="0.55" stop-color="#f59e0b"/>
      <stop offset="1" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde68a"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <circle cx="${c}" cy="${c}" r="${planetR}" fill="url(#planet)"/>
  <g transform="rotate(-18 ${c} ${c})">
    <path d="M ${c - ringRx} ${c} A ${ringRx} ${ringRy} 0 0 0 ${c + ringRx} ${c}"
      fill="none" stroke="url(#ring)" stroke-width="${size * 0.022}" stroke-linecap="round"/>
  </g>
</svg>`;
}

await mkdir(OUT, { recursive: true });

await Promise.all([
  sharp(Buffer.from(planetSvg({ size: 512 }))).png().toFile(`${OUT}/icon-512.png`),
  sharp(Buffer.from(planetSvg({ size: 192 }))).png().toFile(`${OUT}/icon-192.png`),
  sharp(Buffer.from(planetSvg({ size: 180 }))).png().toFile(`${OUT}/apple-touch-icon.png`),
  sharp(Buffer.from(planetSvgMaskable(512))).png().toFile(`${OUT}/maskable-512.png`),
  sharp(Buffer.from(planetSvg({ size: 32 }))).png().toFile(`${OUT}/favicon.png`),
]);

console.log("✓ Icônes Orbit générées dans public/icons/");
