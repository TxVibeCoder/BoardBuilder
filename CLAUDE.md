# CLAUDE.md — BoardBuilder conventions

An interactive virtual **eyelet board** for *learning how analog audio circuits work*: drop
real-looking components, wire them, turn a knob, and build intuition for what each part does to
the signal. Sibling project to **SynthStack**, reusing its architecture and conventions verbatim.
The payload is **understanding** — see and hear every change at the same instant.

Named **BoardBuilder** (decided 2026-06-22).

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck + production build
- `npm run preview` — serve the built app locally
- `npm test` — Vitest unit suite (the pure cores)
- `npm run typecheck` — `tsc -b`

## Conventions (the load-bearing rules)

- **Learning-first.** Fidelity bar = correct **direction + rough magnitude** for every component.
  Temperature-modeled bias, manufacturer-accurate device models, emulation-grade nonlinearity are
  out of scope.
- **Seeing and hearing are equal partners.** Every change is both visible (scope / response / bias)
  and audible, live and **in lock-step**. Neither is "the product"; the learning is in the simultaneity.
- **The model: eyelet = node.** An eyelet is one electrical node (net); a component or jumper is an
  **edge** between two eyelets. The **netlist is the single source of truth**; the renderer is a pure
  function of it. (Same discipline as SynthStack's `studioState`: a `getState`/`setState` JSON
  round-trip will be enforced by a test from Phase 1.)
- **Engine: nodal solver only.** Modified Nodal Analysis + Newton-Raphson for nonlinear parts,
  trapezoidal/backward-Euler companion models for reactive parts. Real-time audio path uses the
  **DK-method**: precompute the linear-part matrices, Newton-iterate only the nonlinear elements per
  sample; refactor only on **topology** change, just update entries on a **knob turn**. Oversample
  clipping stages. **WDF is a recorded rejection** — do not relitigate (see DECISIONS.md).
- **Pure cores + thin shells.** Solver/DSP lives in `src/engine/dsp/*Core.ts` with **no Web Audio
  types**, fully unit-tested in Node. AudioWorklet wrappers in `src/engine/worklets/` are thin shells
  that only marshal buffers/params. **No allocations or logging inside worklet `process()`** —
  preallocate in constructors.
- **Virtual-volts continuity.** Node voltages are *literally* volts; vv ↔ volts conversion lives in
  exactly one place: `src/engine/units.ts`.
- **Rendering: parametric SVG, value-driven.** Components are parametric SVG (no photos); appearance
  is computed from value (resistor bands, electrolytic stripe, diode cathode band). Each component is
  `(value, orientation, state) → SVG` that also declares its lead/pin anchor points. Real-world
  relative sizing: real mm, fixed px-per-mm.
- **Reuse SynthStack** directly: `ui/cables/CableLayer` + `cableGeometry` (jumper wires), the
  `Jack`/`Knob`/`Switch` controls (eyelets/terminals/pots), the worklet harness, and the data-driven
  schema/registry idea.

## Status

- **Phase 0 (viability spike) — done.** Hard-coded diode clipper (`engine/dsp/diodeClipperCore.ts`),
  a Vitest acceptance test, and a live scope+play page (`ui/Phase0App.tsx`) proving solve→see→hear.
- **Phase 1 engine — done & tested.** The generalized **N-node MNA + Newton + companion-model** solver
  (`engine/dsp/`: `constants`, `linearSolver` (DenseLU seam), `netlist` (union-find), `components`
  (stamp API + R/C/L/diode/op-amp/pot/source), `mnaSystem`, `circuitCore`). Solves all six §9 starter
  circuits with analytic tests (divider, RC cutoffs, diode clip, op-amp gain/saturation/soft-clip),
  **subsumes Phase 0 numerically**, and fails legibly (floating node, no-ground, pot end-stops). 26
  tests pass. The engine decisions + the full spec are in `DECISIONS.md` / `docs/ENGINE_DESIGN.md`.

**Next (Phase 1 remainder):** oversampler (auto 1×/4×/8×, group-delay-aligned scope), the
`circuit.worklet.ts` thin shell + live audio wiring, then the eyelet-board UI (drop → eyelets → drag →
snap-merge → split, parametric SVG, scope probe) and the loadable starter circuits.
