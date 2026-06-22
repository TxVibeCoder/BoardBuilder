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
  amp?: number; // source amplitude (V)
  rsrc?: number; // source series impedance (Ω); small ≈ ideal
  ideal?: boolean; // source: ideal voltage (aux row) instead of Norton
  wave?: 'sine' | 'guitar'; // source waveform; 'guitar' reads the external input sample
  polarity?: boolean; // electrolytic cap orientation (display/warning only)
}

export interface ComponentSpec {
  id: string;
  kind: ComponentKind;
  /** Eyelet ids. R/C/L/D: [a,b]; opamp: [plus,minus,out]; pot: [a,wiper,b]; source: [hot,gnd]; probe/jumper: 2. */
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
