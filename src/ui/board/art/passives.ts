/**
 * Parametric SVG art for the PASSIVE family — resistor, capacitor, diode (incl. LED) — per the
 * ArtRenderer contract (artTypes.ts §6). Each renderer is a pure `(params) → {svg, width, height,
 * pins}`, real-world sized in MILLIMETRES, with lead anchors named in netlist pin order
 * (resistor/capacitor → ['a','b']; diode → ['a','k']). Appearance is computed FROM the value:
 *  - resistor: the four E-series COLOR BANDS (digit, digit, ×multiplier, tolerance) from params.R;
 *  - capacitor: a small film box, or a taller ELECTROLYTIC can (polarity stripe on 'b', radius
 *    scaled by params.C) when params.polarity is set;
 *  - diode: a tinted body with a CATHODE band at the 'k' end (LED gets a domed, tinted body).
 *
 * NO outer <svg> wrapper, NO DOM, NO Web Audio — a pure string/number module (Node-testable). Sizes
 * are kept small and realistic (a ¼W axial resistor body is ~6.3 mm; a 9 V battery would dwarf it).
 */

import { DIODE_MODELS } from '../../../engine/dsp/constants';
import type { ComponentParams } from '../../../engine/dsp/netlist';
import type { ArtRenderer, ComponentArt } from '../artTypes';

/** Standard resistor color-code palette, indexed 0..9 (black…white) for digits/multiplier. */
const BAND_COLORS = [
  '#1a1a1a', // 0 black
  '#7a3b10', // 1 brown
  '#d11f1f', // 2 red
  '#e07b1a', // 3 orange
  '#f2d019', // 4 yellow
  '#2faa3a', // 5 green
  '#2156c4', // 6 blue
  '#8a37c9', // 7 violet
  '#808080', // 8 grey
  '#f5f5f5', // 9 white
] as const;

const GOLD = '#c9a227'; // 5% tolerance
const SILVER = '#b8bcc2'; // 10% tolerance
const LEAD = '#cfd4da'; // tinned silver lead
const BODY_TAN = '#d8c39a'; // resistor body (carbon-film tan)
const BODY_FILM = '#2f5fb0'; // film-cap box (blue)
const BODY_ELEC = '#1d2733'; // electrolytic can (dark)
const ELEC_STRIPE = '#cfd6df'; // electrolytic polarity stripe (light)

/**
 * Map a resistance (Ω) to the four 4-band resistor color indices: [digit1, digit2, multiplier,
 * tolerance]. digit/multiplier are 0..9 palette indices; tolerance is 'gold' (5%) or 'silver' (10%).
 * Two significant digits × 10^multiplier (e.g. 1 kΩ → brown black red; 100 kΩ → brown black yellow).
 */
export interface ResistorBands {
  d1: number;
  d2: number;
  mult: number;
  tolerance: 'gold' | 'silver';
}

export function resistorColorCode(rOhms: number): ResistorBands {
  // Guard non-finite / non-positive: render a 0 Ω (black/black/black) part rather than NaN bands.
  if (!Number.isFinite(rOhms) || rOhms <= 0) {
    return { d1: 0, d2: 0, mult: 0, tolerance: 'gold' };
  }
  // Decompose into two significant digits and a power-of-ten multiplier.
  let exp = Math.floor(Math.log10(rOhms));
  // Two significant figures live at 10^(exp-1) .. so the multiplier is exp - 1.
  let mantissa = Math.round(rOhms / Math.pow(10, exp - 1)); // 10..100 (two sig figs)
  if (mantissa >= 100) {
    // rounding pushed us up a decade (e.g. 99.6 → 100): re-normalize to keep two digits.
    mantissa = Math.round(mantissa / 10);
    exp += 1;
  }
  if (mantissa < 10) mantissa *= 10; // keep exactly two significant digits
  const d1 = Math.floor(mantissa / 10) % 10;
  const d2 = mantissa % 10;
  // multiplier index (power of ten applied to the 2-digit mantissa), clamped to the 0..9 palette.
  const mult = Math.max(0, Math.min(9, exp - 1));
  return { d1, d2, mult, tolerance: 'gold' };
}

function num(n: number): string {
  // Compact, deterministic mm coordinate (avoid float noise in the SVG string).
  return (Math.round(n * 1000) / 1000).toString();
}

/**
 * ¼W axial resistor: tinned leads on the long axis, a tan body, and four color bands computed from
 * params.R. Pins 'a','b' sit on the lead tips. Body ~6.3 mm, total ~14 mm tip-to-tip.
 */
export const resistorArt: ArtRenderer = (params: ComponentParams): ComponentArt => {
  const bodyLen = 6.3;
  const bodyH = 2.4;
  const lead = 3.85; // each lead length
  const width = bodyLen + 2 * lead; // 14.0 mm tip to tip
  const height = bodyH;
  const cy = height / 2;
  const bodyX = lead;
  const bodyR = 0.6; // rounded body ends

  const bands = resistorColorCode(params.R ?? 0);
  const bandColors = [
    BAND_COLORS[bands.d1]!,
    BAND_COLORS[bands.d2]!,
    BAND_COLORS[bands.mult]!,
    bands.tolerance === 'gold' ? GOLD : SILVER,
  ];
  // First three bands clustered toward the 'a' end, tolerance band set apart toward 'b' (real parts).
  const bandW = 0.55;
  const bandXs = [bodyX + 0.9, bodyX + 1.7, bodyX + 2.5, bodyX + bodyLen - 1.0];
  const bandsSvg = bandColors
    .map(
      (col, i) =>
        `<rect x="${num(bandXs[i]!)}" y="${num(cy - bodyH / 2)}" width="${num(bandW)}" height="${num(bodyH)}" fill="${col}"/>`,
    )
    .join('');

  const svg =
    `<line x1="0" y1="${num(cy)}" x2="${num(bodyX)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<line x1="${num(bodyX + bodyLen)}" y1="${num(cy)}" x2="${num(width)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<rect x="${num(bodyX)}" y="${num(cy - bodyH / 2)}" width="${num(bodyLen)}" height="${num(bodyH)}" rx="${num(bodyR)}" fill="${BODY_TAN}" stroke="#9c8a63" stroke-width="0.15"/>` +
    bandsSvg;

  return {
    svg,
    width,
    height,
    pins: [
      { name: 'a', x: 0, y: cy },
      { name: 'b', x: width, y: cy },
    ],
  };
};

/**
 * Capacitor: a small film box (~5 mm, no polarity) by default; an ELECTROLYTIC can with a polarity
 * stripe on the 'b' (negative) side and a body radius that grows with params.C when params.polarity.
 * Pins 'a','b' on the lead tips.
 */
export const capacitorArt: ArtRenderer = (params: ComponentParams): ComponentArt => {
  const polar = params.polarity === true;
  const lead = 3.0;

  if (!polar) {
    // Film box (boxy, non-polar).
    const bodyW = 5.0;
    const bodyH = 4.0;
    const width = bodyW + 2 * lead;
    const height = bodyH;
    const cy = height / 2;
    const bodyX = lead;
    const svg =
      `<line x1="0" y1="${num(cy)}" x2="${num(bodyX)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
      `<line x1="${num(bodyX + bodyW)}" y1="${num(cy)}" x2="${num(width)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
      `<rect x="${num(bodyX)}" y="${num(cy - bodyH / 2)}" width="${num(bodyW)}" height="${num(bodyH)}" rx="0.6" fill="${BODY_FILM}" stroke="#1c3f7a" stroke-width="0.15"/>`;
    return {
      svg,
      width,
      height,
      pins: [
        { name: 'a', x: 0, y: cy },
        { name: 'b', x: width, y: cy },
      ],
    };
  }

  // Electrolytic can: radius scaled by capacitance (bigger C ⇒ bigger can), clamped to a sane range.
  const c = params.C ?? 1e-6;
  // Map ~1 µF→2.6 mm radius up to ~1000 µF→~5 mm, log-scaled; clamp so tiny/huge values stay readable.
  const decades = Number.isFinite(c) && c > 0 ? Math.log10(c / 1e-6) : 0; // 0 at 1 µF
  const radius = Math.max(2.4, Math.min(5.2, 2.6 + 0.55 * decades));
  const bodyD = radius * 2;
  const width = bodyD + 2 * lead;
  const height = bodyD;
  const cy = height / 2;
  const bodyX = lead;
  const ccx = bodyX + radius;
  const stripeW = 1.2;
  // Polarity stripe (minus) sits on the 'b' / negative side: a light band near the right edge.
  const stripeX = bodyX + bodyD - stripeW;
  const svg =
    `<line x1="0" y1="${num(cy)}" x2="${num(bodyX)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<line x1="${num(bodyX + bodyD)}" y1="${num(cy)}" x2="${num(width)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<circle cx="${num(ccx)}" cy="${num(cy)}" r="${num(radius)}" fill="${BODY_ELEC}" stroke="#0c1218" stroke-width="0.2"/>` +
    // negative-side stripe (clipped to the can via the right-edge band)
    `<rect x="${num(stripeX)}" y="${num(cy - radius * 0.86)}" width="${num(stripeW)}" height="${num(radius * 1.72)}" fill="${ELEC_STRIPE}" opacity="0.92"/>` +
    // a couple of minus marks on the stripe
    `<rect x="${num(stripeX + stripeW / 2 - 0.4)}" y="${num(cy - radius * 0.45)}" width="0.8" height="0.18" fill="${BODY_ELEC}"/>` +
    `<rect x="${num(stripeX + stripeW / 2 - 0.4)}" y="${num(cy + radius * 0.4)}" width="0.8" height="0.18" fill="${BODY_ELEC}"/>`;

  return {
    svg,
    width,
    height,
    pins: [
      { name: 'a', x: 0, y: cy },
      { name: 'b', x: width, y: cy },
    ],
  };
};

/**
 * Diode: an axial body with a CATHODE band at the 'k' end; the body is tinted per params.diode
 * (Si grey-black glass, Ge dark-red glass) and an LED is drawn as a larger domed, tinted body.
 * Pins 'a' (anode) and 'k' (cathode) on the lead tips, in netlist order.
 */
export const diodeArt: ArtRenderer = (params: ComponentParams): ComponentArt => {
  const id = params.diode ?? 'Si';
  const model = DIODE_MODELS[id];
  const isLed = id === 'LED';
  const lead = 3.4;

  if (isLed) {
    // 5 mm LED: a domed, color-tinted body. Cathode ('k') marked by the band end + a flat.
    const bodyW = 5.0;
    const bodyH = 5.0;
    const width = bodyW + 2 * lead;
    const height = bodyH;
    const cy = height / 2;
    const bodyX = lead;
    const tint = '#ff5a4d'; // a lit red LED (teaching cue; vf hint via label only)
    const rx = bodyW / 2;
    const svg =
      `<line x1="0" y1="${num(cy)}" x2="${num(bodyX)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
      `<line x1="${num(bodyX + bodyW)}" y1="${num(cy)}" x2="${num(width)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
      // domed body: rounded-left rectangle (anode) into a half-dome at the 'a' side
      `<rect x="${num(bodyX)}" y="${num(cy - bodyH / 2)}" width="${num(bodyW)}" height="${num(bodyH)}" rx="${num(rx)}" fill="${tint}" stroke="#a32018" stroke-width="0.2"/>` +
      // highlight
      `<ellipse cx="${num(bodyX + bodyW * 0.4)}" cy="${num(cy - bodyH * 0.22)}" rx="${num(bodyW * 0.18)}" ry="${num(bodyH * 0.12)}" fill="#ffffff" opacity="0.45"/>` +
      // cathode flat + band at the 'k' end
      `<rect x="${num(bodyX + bodyW - 0.7)}" y="${num(cy - bodyH / 2)}" width="0.7" height="${num(bodyH)}" fill="#1a1a1a" opacity="0.8"/>`;
    return {
      svg,
      width,
      height,
      pins: [
        { name: 'a', x: 0, y: cy },
        { name: 'k', x: width, y: cy },
      ],
    };
  }

  // Axial glass/black diode (1N-style). Tint by chemistry: Ge darker red glass, Si grey-black.
  const bodyLen = 5.4;
  const bodyH = 2.6;
  const width = bodyLen + 2 * lead;
  const height = bodyH;
  const cy = height / 2;
  const bodyX = lead;
  const bodyFill = id === 'Ge' ? '#5a2630' : '#26282b'; // Ge dark-red glass vs Si grey-black
  const bandColor = '#e8e8e8'; // cathode band (light, on dark body)
  const bandW = 0.7;
  const bandX = bodyX + bodyLen - 1.4; // toward the 'k' (cathode) / right end
  void model; // model.vf reserved for a future label/tooltip; tint already encodes the chemistry
  const svg =
    `<line x1="0" y1="${num(cy)}" x2="${num(bodyX)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<line x1="${num(bodyX + bodyLen)}" y1="${num(cy)}" x2="${num(width)}" y2="${num(cy)}" stroke="${LEAD}" stroke-width="0.45" stroke-linecap="round"/>` +
    `<rect x="${num(bodyX)}" y="${num(cy - bodyH / 2)}" width="${num(bodyLen)}" height="${num(bodyH)}" rx="0.5" fill="${bodyFill}" stroke="#0d0e0f" stroke-width="0.15"/>` +
    `<rect x="${num(bandX)}" y="${num(cy - bodyH / 2)}" width="${num(bandW)}" height="${num(bodyH)}" fill="${bandColor}"/>`;

  return {
    svg,
    width,
    height,
    pins: [
      { name: 'a', x: 0, y: cy },
      { name: 'k', x: width, y: cy },
    ],
  };
};
