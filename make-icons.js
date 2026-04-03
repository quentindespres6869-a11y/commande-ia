const sharp = require('sharp');
const svg = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="80" fill="#1a3a1a"/>
  <text x="256" y="340" font-size="280" font-family="Arial" font-weight="bold" fill="#a8e07a" text-anchor="middle">C</text>
</svg>`);
sharp(svg).resize(192).png().toFile('public/icon-192.png', () => console.log('icon-192.png créé'));
sharp(svg).resize(512).png().toFile('public/icon-512.png', () => console.log('icon-512.png créé'));
