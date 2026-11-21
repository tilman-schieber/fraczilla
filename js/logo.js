// The "ANSI Shadow" ASCII-art logotype, drawn as SVG so it looks the same in every
// browser: fonts disagree on (or lack) the block and box-drawing glyphs, which
// garbled the plain-text version. █ becomes a solid cell; ═ ║ ╔ ╗ ╚ ╝ become the
// double-line "3D" shadow.

const ART = [
  '███████╗██████╗  █████╗  ██████╗███████╗██╗██╗     ██╗      █████╗ ',
  '██╔════╝██╔══██╗██╔══██╗██╔════╝╚══███╔╝██║██║     ██║     ██╔══██╗',
  '█████╗  ██████╔╝███████║██║       ███╔╝ ██║██║     ██║     ███████║',
  '██╔══╝  ██╔══██╗██╔══██║██║      ███╔╝  ██║██║     ██║     ██╔══██║',
  '██║     ██║  ██║██║  ██║╚██████╗███████╗██║███████╗███████╗██║  ██║',
  '╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝╚══════╝╚══════╝╚═╝  ╚═╝',
];

const W = 10, H = 20;       // a terminal cell
const OY = 3, OX = 2.5;      // offsets of the double lines from the cell centre

export function asciiLogoSVG() {
  const cols = Math.max(...ART.map((r) => [...r].length));
  let blocks = '', lines = '';
  const seg = (x1, y1, x2, y2) => { lines += `M${x1} ${y1}L${x2} ${y2}`; };
  ART.forEach((row, j) => {
    [...row].forEach((ch, i) => {
      const x = i * W, y = j * H, cx = x + W / 2, cy = y + H / 2;
      switch (ch) {
        case '█': blocks += `M${x} ${y}h${W + 0.4}v${H + 0.4}h${-W - 0.4}z`; break;
        case '═': seg(x, cy - OY, x + W, cy - OY); seg(x, cy + OY, x + W, cy + OY); break;
        case '║': seg(cx - OX, y, cx - OX, y + H); seg(cx + OX, y, cx + OX, y + H); break;
        case '╔':
          seg(cx - OX, cy - OY, x + W, cy - OY); seg(cx - OX, cy - OY, cx - OX, y + H);
          seg(cx + OX, cy + OY, x + W, cy + OY); seg(cx + OX, cy + OY, cx + OX, y + H); break;
        case '╗':
          seg(x, cy - OY, cx + OX, cy - OY); seg(cx + OX, cy - OY, cx + OX, y + H);
          seg(x, cy + OY, cx - OX, cy + OY); seg(cx - OX, cy + OY, cx - OX, y + H); break;
        case '╚':
          seg(cx - OX, cy + OY, x + W, cy + OY); seg(cx - OX, y, cx - OX, cy + OY);
          seg(cx + OX, cy - OY, x + W, cy - OY); seg(cx + OX, y, cx + OX, cy - OY); break;
        case '╝':
          seg(x, cy + OY, cx + OX, cy + OY); seg(cx + OX, y, cx + OX, cy + OY);
          seg(x, cy - OY, cx - OX, cy - OY); seg(cx - OX, y, cx - OX, cy - OY); break;
        default: break;
      }
    });
  });
  const vw = cols * W, vh = ART.length * H;
  return `<svg viewBox="-2 -2 ${vw + 4} ${vh + 4}" role="img" aria-label="FRACZILLA" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="lgold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffff8a"/><stop offset=".55" stop-color="#ffff55"/><stop offset="1" stop-color="#ffb300"/>
  </linearGradient></defs>
  <path d="${lines}" fill="none" stroke="#c46a00" stroke-width="1.6" stroke-linecap="square"/>
  <path d="${blocks}" fill="url(#lgold)"/>
</svg>`;
}
