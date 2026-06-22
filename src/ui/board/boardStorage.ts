/**
 * Save / load for the eyelet board — a lossless JSON round-trip of the {@link BoardState}, which IS the
 * board's source of truth (the netlist, the eyelet clustering, and the render are all pure functions of
 * it — see boardModel.ts). So persistence is just "stringify the BoardState, validate it back".
 *
 * Three surfaces, smallest dependency first:
 *  - pure  : `serializeBoard` / `deserializeBoard` — JSON ↔ validated BoardState (Node/vitest-testable).
 *  - browser file : `downloadBoard` / `loadBoardFromFile` — anchor+Blob save, FileReader load.
 *  - localStorage : named `saveSlot` / `loadSlot` / `listSlots` / `deleteSlot`.
 *
 * The validator is deliberately strict and legible: it throws a clear Error naming exactly what is wrong,
 * so a hand-edited or truncated file fails loudly rather than loading a half-board that mis-solves later.
 */

import type { ComponentKind, ComponentParams } from '../../engine/dsp/netlist';
import type { BoardComponent, BoardState, PinRef } from './boardModel';

/** Bumped only if the on-disk shape changes incompatibly; carried through the round-trip for forward use. */
export const BOARD_FORMAT_VERSION = 1;

/** localStorage key namespace for named slots (`bb.board.<name>`); kept distinct so listSlots is exact. */
const SLOT_PREFIX = 'bb.board.';

const COMPONENT_KINDS: readonly ComponentKind[] = [
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'opamp',
  'pot',
  'bjt',
  'source',
  'probe',
  'jumper',
];

/** The serialized envelope: a format tag + the BoardState verbatim (BoardState is already plain JSON). */
interface BoardFile {
  format: 'boardbuilder';
  version: number;
  board: BoardState;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Serialize a board to a pretty JSON string (stable, human-diffable). */
export function serializeBoard(board: BoardState): string {
  const file: BoardFile = { format: 'boardbuilder', version: BOARD_FORMAT_VERSION, board };
  return JSON.stringify(file, null, 2);
}

/** Validate a PinRef (jumper endpoint); throws a located Error on a bad shape. */
function validatePinRef(v: unknown, where: string): PinRef {
  if (!isObject(v)) throw new Error(`${where}: expected an object {componentId, pinIndex}`);
  if (typeof v.componentId !== 'string') throw new Error(`${where}.componentId must be a string`);
  if (typeof v.pinIndex !== 'number' || !Number.isInteger(v.pinIndex) || v.pinIndex < 0)
    throw new Error(`${where}.pinIndex must be a non-negative integer`);
  return { componentId: v.componentId, pinIndex: v.pinIndex };
}

/** Validate one placed component; throws a located Error on a bad shape. */
function validateComponent(v: unknown, where: string): BoardComponent {
  if (!isObject(v)) throw new Error(`${where}: expected a component object`);
  if (typeof v.id !== 'string' || v.id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
  if (typeof v.kind !== 'string' || !COMPONENT_KINDS.includes(v.kind as ComponentKind))
    throw new Error(`${where}.kind '${String(v.kind)}' is not a known ComponentKind`);
  if (!isObject(v.params)) throw new Error(`${where}.params must be an object`);
  if (typeof v.x !== 'number' || !Number.isFinite(v.x)) throw new Error(`${where}.x must be a finite number`);
  if (typeof v.y !== 'number' || !Number.isFinite(v.y)) throw new Error(`${where}.y must be a finite number`);

  const comp: BoardComponent = {
    id: v.id,
    kind: v.kind as ComponentKind,
    params: { ...(v.params as ComponentParams) },
    x: v.x,
    y: v.y,
  };
  if (v.rot !== undefined) {
    if (typeof v.rot !== 'number' || !Number.isFinite(v.rot)) throw new Error(`${where}.rot must be a finite number`);
    comp.rot = v.rot;
  }
  if (v.kind === 'jumper') {
    if (!isObject(v.link)) throw new Error(`${where}: a jumper must carry a link {a, b}`);
    comp.link = {
      a: validatePinRef(v.link.a, `${where}.link.a`),
      b: validatePinRef(v.link.b, `${where}.link.b`),
    };
  } else if (v.link !== undefined) {
    // tolerate a stray link on a non-jumper by carrying it through only if well-formed; else drop it
    if (isObject(v.link) && isObject(v.link.a) && isObject(v.link.b))
      comp.link = { a: validatePinRef(v.link.a, `${where}.link.a`), b: validatePinRef(v.link.b, `${where}.link.b`) };
  }
  return comp;
}

/** Validate a BoardState shape (the inner payload, post-envelope-unwrap). */
function validateBoard(v: unknown): BoardState {
  if (!isObject(v)) throw new Error('board: expected an object {components, sampleRate, nextId}');
  if (!Array.isArray(v.components)) throw new Error('board.components must be an array');
  if (typeof v.sampleRate !== 'number' || !(v.sampleRate > 0)) throw new Error('board.sampleRate must be a positive number');
  if (typeof v.nextId !== 'number' || !Number.isInteger(v.nextId) || v.nextId < 0)
    throw new Error('board.nextId must be a non-negative integer');
  const components = v.components.map((c, i) => validateComponent(c, `board.components[${i}]`));
  return { components, sampleRate: v.sampleRate, nextId: v.nextId };
}

/**
 * Parse a saved board back into a validated {@link BoardState}. Accepts both the current enveloped form
 * (`{format,version,board}`) and a bare BoardState (forward-tolerant), so a hand-pasted state still loads.
 * Throws a clear Error on malformed JSON or a bad shape.
 */
export function deserializeBoard(json: string): BoardState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Not valid board JSON: ${(e as Error).message}`);
  }
  if (isObject(parsed) && parsed.format === 'boardbuilder') {
    if ('board' in parsed) return validateBoard(parsed.board);
    throw new Error('Board file is missing its "board" payload');
  }
  // bare BoardState (no envelope) — validate directly
  return validateBoard(parsed);
}

// ── Browser file I/O ────────────────────────────────────────────────────────────────────────────

/** A safe default download filename derived from the date (no slot name available here). */
function defaultFilename(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `board-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Trigger a browser download of the board as a `.json` file (anchor + Blob, no server). */
export function downloadBoard(board: BoardState, filename?: string): void {
  const name = (filename && filename.trim()) || defaultFilename();
  const blob = new Blob([serializeBoard(board)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.json') ? name : `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke after the click is dispatched so the download isn't cancelled
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a user-picked file (from an <input type=file>) and parse+validate it into a BoardState. */
export function loadBoardFromFile(file: File): Promise<BoardState> {
  return new Promise<BoardState>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read file '${file.name}'`));
    reader.onload = () => {
      try {
        resolve(deserializeBoard(String(reader.result ?? '')));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    reader.readAsText(file);
  });
}

// ── localStorage named slots ──────────────────────────────────────────────────────────────────────

/** The browser localStorage, or null when unavailable (SSR / Node / privacy mode). */
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // access can throw in some sandboxed contexts
  }
}

const slotKey = (name: string): string => `${SLOT_PREFIX}${name}`;

/** Save a board into a named slot in localStorage (overwrites). No-op (returns false) if storage is off. */
export function saveSlot(name: string, board: BoardState): boolean {
  const s = storage();
  if (!s) return false;
  if (!name || !name.trim()) throw new Error('saveSlot: a non-empty slot name is required');
  s.setItem(slotKey(name), serializeBoard(board));
  return true;
}

/** Load a named slot, or null if it does not exist / storage is off. Throws if the stored data is corrupt. */
export function loadSlot(name: string): BoardState | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(slotKey(name));
  if (raw === null) return null;
  return deserializeBoard(raw);
}

/** List the names of all saved slots (sorted), excluding the prefix. Empty when storage is off. */
export function listSlots(): string[] {
  const s = storage();
  if (!s) return [];
  const names: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key && key.startsWith(SLOT_PREFIX)) names.push(key.slice(SLOT_PREFIX.length));
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Delete a named slot (no-op if absent / storage off). */
export function deleteSlot(name: string): void {
  const s = storage();
  if (!s) return;
  s.removeItem(slotKey(name));
}
