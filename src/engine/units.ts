/**
 * "Virtual volts" (vv) conventions — the SINGLE conversion point (work order §5, §12).
 *
 * In BoardBuilder, unlike SynthStack, node voltages are *literally* volts: a node's
 * solved potential is the real circuit voltage, so vv ↔ volts is the identity. We still
 * keep one conversion module so the convention has a home and a Phase-2 "real-volt label
 * on the scope vs. internal vv" decision has exactly one place to change.
 *
 * Anything that needs to turn an internal number into a displayed quantity (volts on the
 * scope, ohms on a resistor, farads on a cap) goes through here.
 */

export const VOLTS_PER_VV = 1; // identity: 1 vv == 1 V (see DECISIONS.md "Display units")

export function vvToVolts(vv: number): number {
  return vv * VOLTS_PER_VV;
}

export function voltsToVv(v: number): number {
  return v / VOLTS_PER_VV;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Human label for a resistance in Ω / kΩ / MΩ (direction+magnitude bar — not E-series snapped). */
export function formatOhms(r: number): string {
  if (r >= 1e6) return `${(r / 1e6).toFixed(r >= 1e7 ? 0 : 1)} MΩ`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(r >= 1e4 ? 0 : 1)} kΩ`;
  return `${r.toFixed(0)} Ω`;
}

/** Human label for a voltage (mV under 1 V, else V). */
export function formatVolts(v: number): string {
  const a = Math.abs(v);
  if (a < 1) return `${(v * 1000).toFixed(0)} mV`;
  return `${v.toFixed(2)} V`;
}

/**
 * Potentiometer wiper-position end-stop guard. A pot turned fully CW/CCW would put alpha at exactly
 * 1 or 0, making one leg 0 Ω or ∞ Ω — a divide-by-zero NaN on a routine drag. Clamping alpha strictly
 * inside (0,1) here, at the single conversion point, makes both legs always finite. (Engine spec §7.)
 */
export const ALPHA_EPS = 1e-4;
export function clampPotAlpha(a: number): number {
  return clamp(a, ALPHA_EPS, 1 - ALPHA_EPS);
}
