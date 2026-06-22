# DECISIONS — BoardBuilder

Running log of choices, with rationale. Mirrors SynthStack's `DECISIONS.md` discipline. The
work-order §11 "open decisions" are recorded here as **provisional** where Phase 0 forced a value;
none of them blocked the spike, so they are flagged rather than guessed-and-buried.

## Recorded rejections (do not relitigate)

- **WDF (Wave Digital Filters) — REJECTED as the engine.** WDF needs a valid, decomposable circuit
  before it runs and chokes on arbitrary topologies and multiple nonlinearities. A learning tool must
  let people wire *anything* — including wrong things — and still show what happens. A nodal solver
  handles any topology drawn, hands the scope its node voltages for free, and fails legibly (a floating
  node is itself a teaching moment). Recorded so it isn't reopened. (Work order §4.)

## Settled (Phase 0)

- **Engine = nodal (MNA) + Newton-Raphson.** Phase 0 implements it at one node / one nonlinear element
  in `diodeClipperCore.ts` — the real method in miniature. Phase 1 generalises the same
  conductance/Jacobian assembly to N nodes and adds trapezoidal companion models for caps/inductors.
- **Virtual-volts = real volts (identity).** Node voltages are literally volts. One conversion point:
  `src/engine/units.ts` (`VOLTS_PER_VV = 1`).
- **Stack = SynthStack's.** TS + Vite + React, Vitest, pure cores + thin worklet shells, the
  `?worker&url` worklet-loading trick, fft.js spectral test helpers.

## Settled — Phase 1 engine (design workflow, 2026-06-22)

These were the §11 open numerical-methods questions delegated with a "build it right, correctness over
speed" directive. Decided via a multi-agent design pass (decide → adversarial-verify → architect → synthesize);
full rationale + the generalized-solver spec live in the gitignored `docs/ENGINE_DESIGN.md`. Each was
adversarially stress-tested and the failure it would have caused is recorded.

- **Per-sample solve = general MNA + Newton-Raphson, re-stamped/re-factored every sample, behind a
  three-method seam** — `assembleTopology()` (static linear stamp → `G0/RHS0`, on add/remove/rewire),
  `updateValue()` (patch only the changed component's entries on a knob turn — glitch-free, warm-start
  preserved), `processSubSample()` (memcpy `G0`→working, add companion + nonlinear stamps, warm-started
  Newton). **This *is* the DK decomposition expressed as a solver boundary** — shipping DK later (cache
  `LU(G0)`, Schur-reduce to nonlinear ports) is a localized internals swap behind unchanged signatures.
  Re-stamping (vs hand-tuned DK now) is chosen because at Phase-1 sizes (n ≤ ~10) a dense LU is a few
  hundred flops, and re-deriving from the netlist each sample has no stale cached state to corrupt while
  users wire broken circuits on purpose.
- **Op-amp = finite-gain SATURATING source** `out = Vsat·tanh(A·(v+−v−)/Vsat)`, A=1e5, one aux current
  unknown (implemented, tested §9.5/§9.6). In the linear region this pins v+≈v− to ~1/A so closed-loop
  `gain = 1+Rf/Rg` holds exactly; past the rail the tanh bounds the output at ±Vsat and the bound
  propagates downstream + arrests integrators. Default `Vsat = 9 V` (settable). **Correction to the
  design (found during implementation):** the original "ideal nullor + anti-parallel rail-clamp diodes"
  does NOT work — a nullor sources *unbounded* output current, so clamp diodes to ±Vsat can't bound it;
  saturation means leaving the v+=v− regime, which only a finite-gain model represents. A post-solve
  display clamp was also rejected — verified wrong by 6–13× the instant the op-amp drives a downstream
  stage (the cascaded-stage "121 V" regression is now bounded at ~9 V, tested).
- **Reactive integration = backward-Euler default, auto-upgrade to trapezoidal per-cap only when the RC
  corner is safely in-band** (`tau/dt ≥ TRAP_SAFE`), plus a one-sample BE relatch guard after any
  topology change. Verified: trapezoidal **rings** (negative discrete pole) on an ordinary 1nF+1k cap —
  a phantom Nyquist buzz on the scope *and* audio. BE never rings; the `1/(2πRC)` corner is exact under
  both, BE's only cost is mild in-band HF droop.
- **Oversampling = whole-solve, polyphase half-band FIR cascade, factor auto-latched at topology change**
  — `1×` if no nonlinear element, `4×` default with any diode/rail-clamped op-amp, `8×` only for a
  hot-driven stage. Never changes on a knob turn. Scope trace delayed by the decimator group delay so
  see/hear stay coincident. (Implemented after the OS=1 core is proven.)
- **TS → WASM = stay pure TS for all of Phase 1.** The real deliverable now is the narrow
  `LinearSolver` / Newton seams so a later WASM (or DK) swap is one swappable module. Port only when a
  **measured** trigger trips (block solve > ~1.07 ms sustained, n > 12, > 4 nonlinear devices, or > 8
  Newton iters/sample sustained). At n=8 a dense LU at 4 iters is ~1–10% of one core's budget.
- **Regularization = split GMIN + union-find shorts + clamped pot end-stops.** `GMIN_COND = 1e-12` on
  every node diagonal for conditioning (verified: does *not* load a 10MΩ/10MΩ divider — a single global
  GMIN of 1e-6 collapsed it to 0.083, catastrophically wrong); a *separate* `GMIN_FLOAT = 1e-7` applied
  ONLY to LU-flagged singular/floating rows, then re-factored + flagged (the floating-node teaching
  moment). Jumpers UNION eyelets (a short is a node-merge, not an Inf stamp); pot `alpha` clamped to
  `[1e-4, 1-1e-4]` at the one `units.ts` conversion point (raw 0/1 was a verified divide-by-zero NaN).

## Engine review hardening (2026-06-22)

A 5-dimension adversarial review (numerics / robustness / no-alloc / architecture / coverage, each
finding independently verified) ran against the new engine. Fixed + regression-tested:

- **Ideal-source aux-row drift (was: silent dead circuit).** `auxRowsOf` reserved an MNA row for
  `source.ideal:true` that no stamper filled → singular → whole circuit silenced and mislabeled an
  op-amp fault. Now `ideal:true` degrades to the near-ideal Norton model, and `setSystem` asserts
  `nodeCount + Σ stamper.auxRows === n` so this class of seam drift fails loudly at assembly, never silently.
- **Reactive history corruption on a bad sample.** `commitSample` now runs ONLY after a good solve;
  a failed/zeroed sample HOLDS the previous cap/inductor history instead of latching zero/garbage.
- **Single-pin floating fallback (was: a second stray subnet silenced the board).** The pin-and-refactor
  now LOOPS, so multiple disjoint floating subnets are all pinned and the grounded part still solves.
- **Reactive-only nodes misclassified onto trapezoidal (rang).** The BE/TR choice now requires a real
  resistive damping path (else backward-Euler), and is LATCHED per topology so a knob turn can't flip
  the method mid-stream.
- **Sticky teaching badges.** Transient flags (`FLOATING`/`NONCONVERGED`/`NONFINITE`) reset per sample
  so a badge clears when its condition resolves; `flagsAccum` remains the "ever-seen" set.
- **Source phase click on a frequency knob turn.** The sine source now uses a free-running wrapped phase
  accumulator (not absolute time × freq), so a frequency change stays phase-continuous.

**Consciously deferred (low severity, documented):** a node reachable only through a series cap has no
DC path but isn't flagged floating (the cap's companion conductance keeps it non-singular) — defensible
(an ideal cap really has no DC reference); revisit if a "no DC path" teaching badge is wanted. And the
floating-node pin is re-detected each Newton iteration on a broken circuit (bounded extra LU factors,
broken-circuit-only) rather than cached.

## Settled (earlier)

- **Engine = nodal (MNA) + Newton-Raphson; WDF rejected** (see above). Phase 0's `diodeClipperCore.ts`
  is the 1-node reference the generalized engine subsumes (proven by a numeric subsumption test).
- **Virtual-volts = real volts (identity).** One conversion point: `src/engine/units.ts`.
- **Stack = SynthStack's.** TS + Vite + React, Vitest, pure cores + thin worklet shells, `?worker&url`
  worklet loading, fft.js spectral test helpers.
- **Default placement = freeform** (owner decision, 2026-06-22). Drag/drop freely, no grid; the only "snap" is the
  electrical leg→eyelet **merge** on drop (work order §7).
- **Name = BoardBuilder** (owner decision, 2026-06-22). Folder, package, Vite base `boardbuilder`; worklet
  processors `boardbuilder-*`.

## Still provisional

- **Display units.** Scope shows **real-volt labels** (vv == V, no ambiguity yet). The single conversion
  point exists so a later "internal vv ↔ labeled real-volts" split is one edit.
- **Diode device constants** (`DIODE_MODELS`) are **nominal teaching values**, not manufacturer parts —
  chosen so Ge < Si < LED in forward drop, within the direction+magnitude bar. Tune later if needed.

## Project hygiene (inherited from SynthStack)

- Committed files must carry **no personal info and no private upstream history**. This is a fresh,
  independent repo. Keep design scratch in the gitignored `docs/`.
