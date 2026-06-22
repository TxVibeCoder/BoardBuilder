/**
 * Parametric SVG art for the ACTIVE + I/O components (work order §6): op-amp (DIP-8), potentiometer,
 * signal source, and scope probe. Each renderer is a pure `(params) → ComponentArt` returning an SVG
 * fragment (NO outer <svg>) in MILLIMETRES, plus lead/terminal anchors in netlist pin order:
 *   opamp → ['plus','minus','out'];  pot → ['a','wiper','b'];  source → ['hot','gnd'];  probe → ['tip'].
 *
 * Appearance is value-driven where it teaches: the source glyph follows `params.wave` (sine wiggle vs.
 * a guitar-in jack), the pot indicator angle follows `params.alpha` (0..1 → CCW..CW). No photos, no DOM.
 */

import type { ComponentParams } from '../../../engine/dsp/netlist';
import type { ArtPin, ArtRenderer, ComponentArt } from '../artTypes';
import { clamp } from '../../../engine/units';

/** Round a mm coordinate for compact, stable SVG text (3 decimals ≈ sub-µm — far below px-per-mm). */
function f(n: number): string {
  return Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : '0';
}

/**
 * Op-amp as a real DIP-8 package: ~9.8 mm long × 6.4 mm wide body, the pin-1 end-notch + dot, and the
 * three *signal* leads we expose (the netlist op-amp is a 3-pin ideal model, not all 8 legs). Pin-1 (−in)
 * and pin-2 (+in) sit on the left edge; the output (pin-6) sits on the right edge — sensible DIP locations.
 */
export const opampArt: ArtRenderer = (_params: ComponentParams): ComponentArt => {
  const bodyW = 9.8;
  const bodyH = 6.4;
  const lead = 1.2; // lead stub length (mm) beyond the body edge
  const width = bodyW + 2 * lead;
  const height = bodyH;
  const bx = lead; // body left edge
  const by = 0;
  const notchR = 0.9;
  // signal-lead anchor rows (left edge: +in upper, −in lower; right edge: out mid)
  const yPlus = by + bodyH * 0.3;
  const yMinus = by + bodyH * 0.7;
  const yOut = by + bodyH * 0.5;
  const pins: ArtPin[] = [
    { name: 'plus', x: 0, y: yPlus },
    { name: 'minus', x: 0, y: yMinus },
    { name: 'out', x: width, y: yOut },
  ];
  const svg =
    `<g class="bb-opamp">` +
    `<rect x="${f(bx)}" y="${f(by)}" width="${f(bodyW)}" height="${f(bodyH)}" rx="0.5" ` +
    `fill="#1c1c20" stroke="#000" stroke-width="0.2"/>` +
    // pin-1 orientation notch (top-centre of the body) + dot near pin 1 (lower-left)
    `<path d="M${f(bx + bodyW / 2 - notchR)} ${f(by)} A ${f(notchR)} ${f(notchR)} 0 0 0 ${f(bx + bodyW / 2 + notchR)} ${f(by)}" ` +
    `fill="#0c0c0e"/>` +
    `<circle cx="${f(bx + 1.2)}" cy="${f(by + bodyH - 1.2)}" r="0.5" fill="#3a3a42"/>` +
    // exposed leads
    `<line x1="${f(0)}" y1="${f(yPlus)}" x2="${f(bx)}" y2="${f(yPlus)}" stroke="#b9b9c2" stroke-width="0.45"/>` +
    `<line x1="${f(0)}" y1="${f(yMinus)}" x2="${f(bx)}" y2="${f(yMinus)}" stroke="#b9b9c2" stroke-width="0.45"/>` +
    `<line x1="${f(bx + bodyW)}" y1="${f(yOut)}" x2="${f(width)}" y2="${f(yOut)}" stroke="#b9b9c2" stroke-width="0.45"/>` +
    // +/- labels on the inputs
    `<text x="${f(bx + 0.8)}" y="${f(yPlus + 0.5)}" font-size="1.6" fill="#cfcfd6">+</text>` +
    `<text x="${f(bx + 0.8)}" y="${f(yMinus + 0.5)}" font-size="1.6" fill="#cfcfd6">−</text>` +
    `</g>`;
  return { svg, width, height, pins };
};

/**
 * Three-terminal potentiometer: a round body (~16 mm — a common 16 mm pot) with a knurled knob and an
 * indicator line whose angle tracks `params.alpha` (0 → fully CCW, 1 → fully CW; ~300° sweep). The three
 * terminals 'a','wiper','b' exit the bottom edge in the usual left-centre-right arrangement.
 */
export const potArt: ArtRenderer = (params: ComponentParams): ComponentArt => {
  const bodyD = 16; // body diameter (mm)
  const r = bodyD / 2;
  const leadDrop = 3; // terminal stub below the body (mm)
  const width = bodyD;
  const height = bodyD + leadDrop;
  const cx = width / 2;
  const cy = r;
  const knobR = 5;
  // indicator: alpha 0..1 maps over a 300° sweep, centred at the top (12 o'clock), CCW..CW
  const a = clamp(params.alpha ?? 0.5, 0, 1);
  const sweep = 300; // degrees
  const angDeg = -150 + a * sweep; // -150° = full CCW, +150° = full CW, 0° straight up
  const ang = (angDeg - 90) * (Math.PI / 180); // SVG 0° points +x; shift so 0° points up
  const ix = cx + Math.cos(ang) * (knobR - 0.8);
  const iy = cy + Math.sin(ang) * (knobR - 0.8);
  const yLead = bodyD; // body bottom
  const yTip = height;
  const xa = cx - r * 0.55;
  const xb = cx + r * 0.55;
  const pins: ArtPin[] = [
    { name: 'a', x: xa, y: yTip },
    { name: 'wiper', x: cx, y: yTip },
    { name: 'b', x: xb, y: yTip },
  ];
  const svg =
    `<g class="bb-pot">` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#26262c" stroke="#000" stroke-width="0.25"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(knobR)}" fill="#3c3c44" stroke="#15151a" stroke-width="0.3"/>` +
    `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(ix)}" y2="${f(iy)}" stroke="#f2c14e" stroke-width="0.7" stroke-linecap="round"/>` +
    // three terminal leads
    `<line x1="${f(xa)}" y1="${f(yLead)}" x2="${f(xa)}" y2="${f(yTip)}" stroke="#b9b9c2" stroke-width="0.5"/>` +
    `<line x1="${f(cx)}" y1="${f(yLead)}" x2="${f(cx)}" y2="${f(yTip)}" stroke="#b9b9c2" stroke-width="0.5"/>` +
    `<line x1="${f(xb)}" y1="${f(yLead)}" x2="${f(xb)}" y2="${f(yTip)}" stroke="#b9b9c2" stroke-width="0.5"/>` +
    `</g>`;
  return { svg, width, height, pins };
};

/**
 * Signal source. Default (`wave === 'sine'`, or unset) draws a sine-wave glyph inside a circle — the
 * classic AC-source symbol. `wave === 'guitar'` instead draws a ¼" guitar-input jack (a barrel + tip),
 * signalling "the external input sample drives this node". Terminals 'hot','gnd' exit the right edge.
 */
export const sourceArt: ArtRenderer = (params: ComponentParams): ComponentArt => {
  const isGuitar = params.wave === 'guitar';
  const bodyD = 10;
  const r = bodyD / 2;
  const leadRun = 2.5;
  const width = bodyD + leadRun;
  const height = bodyD;
  const cy = r;
  const yHot = bodyD * 0.32;
  const yGnd = bodyD * 0.68;
  const pins: ArtPin[] = [
    { name: 'hot', x: width, y: yHot },
    { name: 'gnd', x: width, y: yGnd },
  ];
  const leads =
    `<line x1="${f(bodyD)}" y1="${f(yHot)}" x2="${f(width)}" y2="${f(yHot)}" stroke="#b9b9c2" stroke-width="0.45"/>` +
    `<line x1="${f(bodyD)}" y1="${f(yGnd)}" x2="${f(width)}" y2="${f(yGnd)}" stroke="#b9b9c2" stroke-width="0.45"/>`;
  let glyph: string;
  if (isGuitar) {
    // ¼" jack: a barrel with a protruding tip — the "guitar in" affordance
    glyph =
      `<g class="bb-source-guitar">` +
      `<circle cx="${f(r)}" cy="${f(cy)}" r="${f(r)}" fill="#202028" stroke="#000" stroke-width="0.25"/>` +
      `<rect x="${f(r - 2.6)}" y="${f(cy - 1.6)}" width="5.2" height="3.2" rx="0.6" fill="#11111a" stroke="#444" stroke-width="0.2"/>` +
      `<rect x="${f(r + 2.0)}" y="${f(cy - 0.7)}" width="2.4" height="1.4" rx="0.4" fill="#9a9aa6"/>` +
      `<circle cx="${f(r - 1.0)}" cy="${f(cy)}" r="0.9" fill="#000"/>` +
      `</g>`;
  } else {
    // sine-wave glyph in a circle (AC source)
    const w = 5.0; // wave horizontal span
    const amp = 1.7;
    const x0 = r - w / 2;
    const x1 = r + w / 2;
    const path =
      `M${f(x0)} ${f(cy)} ` +
      `C ${f(x0 + w * 0.25)} ${f(cy - amp)}, ${f(r - w * 0.0)} ${f(cy - amp)}, ${f(r)} ${f(cy)} ` +
      `C ${f(r + w * 0.0)} ${f(cy + amp)}, ${f(x1 - w * 0.25)} ${f(cy + amp)}, ${f(x1)} ${f(cy)}`;
    glyph =
      `<g class="bb-source-sine">` +
      `<circle cx="${f(r)}" cy="${f(cy)}" r="${f(r)}" fill="#202028" stroke="#000" stroke-width="0.25"/>` +
      `<path d="${path}" fill="none" stroke="#62d0ff" stroke-width="0.6" stroke-linecap="round"/>` +
      `</g>`;
  }
  return { svg: glyph + leads, width, height, pins };
};

/**
 * Scope probe / test point: a small spring-clip test point with a single 'tip' terminal. Marks the node
 * the scope (and audio output) reads. Tiny footprint — it's a probe touchdown, not a packaged part.
 */
export const probeArt: ArtRenderer = (_params: ComponentParams): ComponentArt => {
  const width = 4.0;
  const height = 5.0;
  const cx = width / 2;
  const yTip = height; // the contact point at the bottom
  const ringCy = 1.6;
  const ringR = 1.3;
  const pins: ArtPin[] = [{ name: 'tip', x: cx, y: yTip }];
  const svg =
    `<g class="bb-probe">` +
    `<circle cx="${f(cx)}" cy="${f(ringCy)}" r="${f(ringR)}" fill="none" stroke="#e23b3b" stroke-width="0.5"/>` +
    `<circle cx="${f(cx)}" cy="${f(ringCy)}" r="0.5" fill="#e23b3b"/>` +
    `<line x1="${f(cx)}" y1="${f(ringCy + ringR)}" x2="${f(cx)}" y2="${f(yTip)}" stroke="#9a9aa6" stroke-width="0.5"/>` +
    `<path d="M${f(cx - 0.7)} ${f(yTip - 1.0)} L ${f(cx)} ${f(yTip)} L ${f(cx + 0.7)} ${f(yTip - 1.0)}" ` +
    `fill="none" stroke="#9a9aa6" stroke-width="0.4"/>` +
    `</g>`;
  return { svg, width, height, pins };
};
