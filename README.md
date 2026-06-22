# BoardBuilder

> An interactive virtual **eyelet board** for *learning how analog audio circuits
> work*. Drop real-looking components, wire them, turn a knob, and build intuition for what each
> part does to the signal. Raise a resistor → gain rises. Add a cap → highs roll off. Swap silicon
> for germanium → the clipping knee softens. The payload is **understanding** — you see the scope
> move and hear the sound change at the same instant.

Sibling project to SynthStack; same stack and conventions (TypeScript + Vite + React, pure cores +
thin worklet shells, Vitest). See `CLAUDE.md` for the load-bearing rules and `DECISIONS.md` for the
choices made so far.

## Status: Phase 0 (viability spike)

Proves the **solve → see → hear** loop on the simplest nonlinear circuit — a diode clipper — before
any eyelet-board UI exists:

- `src/engine/dsp/diodeClipperCore.ts` — nodal solver (MNA + Newton-Raphson) for the clipper node.
  Pure TS, no Web Audio types.
- `src/engine/worklets/diodeClipper.worklet.ts` — thin AudioWorklet shell.
- `src/ui/Phase0App.tsx` — a scope + Play button. Turn **Drive** and watch the trace flatten while
  the sound grinds, in lock-step. Switch Si → Ge → LED, or symmetric ↔ asymmetric.
- `test/unit/diodeClipperCore.test.ts` — asserts the clip (output capped near the diode drop) and the
  harmonic structure (odd harmonics for symmetric, even harmonics for asymmetric).

## Run it

```bash
npm install
npm run dev        # open the printed URL, hit ▶ Play, turn Drive
npm test           # the Phase 0 acceptance battery
npm run typecheck
```

## Where it's going

Phase 1 = the eyelet-as-node board (drop → eyelets appear → drag → snap-merge → split), the full
component set, scope probe, and the DK-method real-time audio path so you can hand-build a circuit and
hear a knob turn continuously while the scope updates in lock-step. See the work order for the full
phased plan.
