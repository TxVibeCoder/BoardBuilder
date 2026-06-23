/**
 * The netlist — BoardBuilder's single source of truth (engine spec §1). Eyelet = one electrical
 * node (net); component/jumper = an edge between eyelet pins. A jumper/wire UNIONs two eyelets into
 * one net (union-find), so a short is a node-merge, not an infinite-conductance stamp.
 *
 * `compileNetlist` turns a Netlist into the index maps the MNA assembler needs: canonical nets,
 * a ground net, node rows, aux rows (op-amps / ideal sources), and per-pin matrix indices. Pure data
 * + integers — no Web Audio, no matrices. getState/setState round-trip via JSON (tested).
 */

import type { DiodeId } from './constants';

export type ComponentKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'opamp'
  | 'pot'
  | 'bjt'
  | 'source'
  | 'probe'
  | 'jumper';

export interface ComponentParams {
  R?: number; // resistor Ω
  C?: number; // capacitor F
  L?: number; // inductor H
  diode?: DiodeId;
  symmetric?: boolean; // diode: anti-parallel pair vs single
  vsat?: number; // op-amp rail (V)
  alpha?: number; // pot wiper position 0..1
  potR?: number; // pot total Ω
  freq?: number; // source sine frequency (Hz)
  amp?: number; // source amplitude (V); for wave 'dc' this is the constant rail voltage
  rsrc?: number; // source series impedance (Ω); small ≈ ideal
  ideal?: boolean; // source: ideal voltage (aux row) instead of Norton
  wave?: 'sine' | 'guitar' | 'dc' | 'noise' | 'pulse'; // source waveform; 'guitar' reads the external input sample; 'dc' = a constant supply rail (Vcc); 'noise' = uniform white noise ±amp; 'pulse' = bipolar square at freq
  bjt?: 'NPN' | 'PNP'; // transistor polarity
  polarity?: boolean; // electrolytic cap orientation (display/warning only)
}

export interface ComponentSpec {
  id: string;
  kind: ComponentKind;
  /** Eyelet ids. R/C/L/D: [a,b]; opamp: [plus,minus,out]; pot: [a,wiper,b]; bjt: [c,b,e]; source: [hot,gnd]; probe/jumper: 2. */
  pins: string[];
  params: ComponentParams;
}

export interface Netlist {
  components: ComponentSpec[];
  sampleRate: number; // 48000
  groundEyelet?: string; // explicit ground; else inferred
  probeEyelet?: string; // explicit scope/output node; else the first probe component's node
}

/**
 * Aux MNA unknowns a component owns (extra rows beyond the nodes). MUST stay in lockstep with the
 * stampers' declared `auxRows` (mnaSystem.setSystem asserts the totals match). The op-amp owns its
 * output-current unknown. NOTE: `source.ideal` does NOT reserve an aux row yet — there is no
 * ideal-voltage-source stamper, so `ideal:true` degrades to the (near-ideal, small-Rsrc) Norton model
 * rather than reserving a row nothing fills. Reinstate the `=== 'source' && ideal` branch only
 * together with a matching aux-row stamper.
 */
export function auxRowsOf(spec: ComponentSpec): number {
  if (spec.kind === 'opamp') return 1;
  return 0;
}

/** Components that contribute no stamp (topology only). */
export function isStructural(kind: ComponentKind): boolean {
  return kind === 'jumper' || kind === 'probe';
}

export interface CompiledNetlist {
  groundOk: boolean;
  nodeCount: number; // M (non-ground nets)
  auxCount: number; // E
  n: number; // M + E
  pinNodes: number[][]; // per component: matrix index per pin (-1 = ground)
  auxBase: number[]; // per component: base aux matrix index, or -1
  nodeOfEyelet: Map<string, number>; // eyelet -> matrix node index (-1 = ground)
  probeIndex: number; // matrix node index the scope/audio reads, or -1
}

class UnionFind {
  private parent = new Map<string, string>();

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function cloneNetlist(n: Netlist): Netlist {
  return JSON.parse(JSON.stringify(n)) as Netlist;
}

export function compileNetlist(net: Netlist): CompiledNetlist {
  const uf = new UnionFind();
  for (const c of net.components) for (const p of c.pins) uf.add(p);
  // jumpers/wires merge their two eyelets into one net
  for (const c of net.components) {
    if (c.kind === 'jumper' && c.pins.length >= 2) uf.union(c.pins[0]!, c.pins[1]!);
  }

  // distinct canonical nets + incidence counts (for ground heuristic)
  const incidence = new Map<string, number>();
  for (const c of net.components) {
    if (c.kind === 'jumper') continue;
    for (const p of c.pins) {
      const r = uf.find(p);
      incidence.set(r, (incidence.get(r) ?? 0) + 1);
    }
  }
  const nets = [...incidence.keys()];
  const groundOk = nets.length > 0;

  // ground net: explicit groundEyelet, else a source's gnd pin (pins[1]), else most-connected net
  let groundRoot: string | null = null;
  if (net.groundEyelet !== undefined) groundRoot = uf.find(net.groundEyelet);
  if (groundRoot === null) {
    const src = net.components.find((c) => c.kind === 'source' && c.pins.length >= 2);
    if (src) groundRoot = uf.find(src.pins[1]!);
  }
  if (groundRoot === null && nets.length > 0) {
    let best = nets[0]!;
    for (const r of nets) if ((incidence.get(r) ?? 0) > (incidence.get(best) ?? 0)) best = r;
    groundRoot = best;
  }

  // assign node indices to non-ground nets
  const nodeOfNet = new Map<string, number>();
  let m = 0;
  for (const r of nets) {
    if (r === groundRoot) {
      nodeOfNet.set(r, -1);
    } else {
      nodeOfNet.set(r, m++);
    }
  }
  const nodeCount = m;

  // aux rows after node rows
  const auxBase: number[] = new Array(net.components.length).fill(-1);
  let aux = 0;
  net.components.forEach((c, i) => {
    const rows = auxRowsOf(c);
    if (rows > 0) {
      auxBase[i] = nodeCount + aux;
      aux += rows;
    }
  });
  const auxCount = aux;

  const idx = (eyelet: string): number => nodeOfNet.get(uf.find(eyelet)) ?? -1;

  const pinNodes = net.components.map((c) => c.pins.map(idx));
  const nodeOfEyelet = new Map<string, number>();
  for (const c of net.components) for (const p of c.pins) nodeOfEyelet.set(p, idx(p));

  // probe node: explicit probeEyelet, else the first probe component's first pin
  let probeIndex = -1;
  if (net.probeEyelet !== undefined) probeIndex = idx(net.probeEyelet);
  if (probeIndex < 0) {
    const probe = net.components.find((c) => c.kind === 'probe' && c.pins.length >= 1);
    if (probe) probeIndex = idx(probe.pins[0]!);
  }

  return { groundOk, nodeCount, auxCount, n: nodeCount + auxCount, pinNodes, auxBase, nodeOfEyelet, probeIndex };
}

/**
 * Teaching check (NOT a solver fault): is the probe pinned to the source through a series part that
 * carries no current? A resistor (or cap, inductor, diode…) sitting in a line between the source and
 * the probe only changes the signal if current flows through it — and current flows only if the probe
 * node has a path to ground OTHER than back through the source (i.e. a divider / return path). With no
 * such path, the series part drops nothing and turning its value does nothing — the #1 dead beginner
 * build `source → resistor → probe`. This detects exactly that so the UI can teach "add a resistor to
 * ground to make a divider".
 *
 * Returns false (no badge) when: a divider/return path exists; an op-amp is present (its output is a
 * driven reference — out of scope, and the no-feedback fault covers its degenerate case); there is no
 * source+probe to reason about; the probe sits on ground; or the probe reads the source directly with
 * nothing in series (probe ≡ source node — you simply haven't added a part yet).
 */
export function probeHasNoReturnPath(net: Netlist): boolean {
  if (net.components.some((c) => c.kind === 'opamp')) return false;
  const src = net.components.find((c) => c.kind === 'source' && c.pins.length >= 2);
  if (!src) return false;

  // resolve nets exactly as compileNetlist does (jumpers merge two eyelets into one net)
  const uf = new UnionFind();
  for (const c of net.components) for (const p of c.pins) uf.add(p);
  for (const c of net.components) if (c.kind === 'jumper' && c.pins.length >= 2) uf.union(c.pins[0]!, c.pins[1]!);

  const groundRoot = net.groundEyelet !== undefined ? uf.find(net.groundEyelet) : uf.find(src.pins[1]!);
  const hotRoot = uf.find(src.pins[0]!);

  let probeRoot: string | null = null;
  if (net.probeEyelet !== undefined) probeRoot = uf.find(net.probeEyelet);
  else {
    const probe = net.components.find((c) => c.kind === 'probe' && c.pins.length >= 1);
    if (probe) probeRoot = uf.find(probe.pins[0]!);
  }
  if (probeRoot === null || probeRoot === groundRoot || probeRoot === hotRoot) return false;

  // Conductive graph over nets, EXCLUDING the source (we want a path to ground that is NOT through the
  // source) and the probe (it draws no current). Caps/inductors/diodes/pot-legs all conduct the signal,
  // so they count as edges — a series cap with no return path is just as "dead" as a series resistor.
  const g = new UnionFind();
  const edge = (a: string, b: string): void => g.union(uf.find(a), uf.find(b));
  for (const c of net.components) {
    switch (c.kind) {
      case 'resistor':
      case 'capacitor':
      case 'inductor':
      case 'diode':
        if (c.pins.length >= 2) edge(c.pins[0]!, c.pins[1]!);
        break;
      case 'pot':
      case 'bjt':
        if (c.pins.length >= 3) {
          edge(c.pins[0]!, c.pins[1]!);
          edge(c.pins[1]!, c.pins[2]!);
        }
        break;
      // source, probe, jumper (already merged above), opamp (excluded above): contribute no edge
    }
  }
  const probeReadsSource = g.find(probeRoot) === g.find(hotRoot); // a series part links probe ← source
  const probeReachesGround = g.find(probeRoot) === g.find(groundRoot); // a divider / return path exists
  return probeReadsSource && !probeReachesGround;
}
