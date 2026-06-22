import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSlot,
  deserializeBoard,
  listSlots,
  loadSlot,
  saveSlot,
  serializeBoard,
} from '../../src/ui/board/boardStorage';
import { PREMADE_CIRCUITS } from '../../src/ui/board/premadeBoards';
import type { BoardState } from '../../src/ui/board/boardModel';

// A non-trivial board: the transistor-boost premade (12 parts + many jumpers, rotations, varied params).
const bjtBoost = (): BoardState => PREMADE_CIRCUITS.find((c) => c.id === 'bjt-boost')!.build();

describe('boardStorage — pure serialize/deserialize', () => {
  it('round-trips a non-trivial board losslessly (deep equality)', () => {
    const board = bjtBoost();
    const back = deserializeBoard(serializeBoard(board));
    expect(back).toEqual(board);
  });

  it('round-trips every premade circuit losslessly', () => {
    for (const c of PREMADE_CIRCUITS) {
      const board = c.build();
      expect(deserializeBoard(serializeBoard(board))).toEqual(board);
    }
  });

  it('preserves rotation, params, and jumper links exactly', () => {
    const board = bjtBoost();
    const back = deserializeBoard(serializeBoard(board));
    const q = back.components.find((c) => c.id === 'Q')!;
    expect(q.rot).toBe(90);
    const jumper = back.components.find((c) => c.kind === 'jumper')!;
    expect(jumper.link).toBeDefined();
    expect(jumper.link!.a).toHaveProperty('componentId');
    expect(jumper.link!.a).toHaveProperty('pinIndex');
  });

  it('accepts a bare (un-enveloped) BoardState', () => {
    const board = bjtBoost();
    const bare = JSON.stringify(board);
    expect(deserializeBoard(bare)).toEqual(board);
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => deserializeBoard('{ not json ]')).toThrow(/Not valid board JSON/);
  });

  it('rejects a board missing sampleRate', () => {
    const bad = JSON.stringify({ components: [], nextId: 1 });
    expect(() => deserializeBoard(bad)).toThrow(/sampleRate/);
  });

  it('rejects a component with an unknown kind', () => {
    const bad = JSON.stringify({
      components: [{ id: 'X1', kind: 'flux-capacitor', params: {}, x: 0, y: 0 }],
      sampleRate: 48000,
      nextId: 2,
    });
    expect(() => deserializeBoard(bad)).toThrow(/ComponentKind/);
  });

  it('rejects a jumper without a link', () => {
    const bad = JSON.stringify({
      components: [{ id: 'W1', kind: 'jumper', params: {}, x: 0, y: 0 }],
      sampleRate: 48000,
      nextId: 2,
    });
    expect(() => deserializeBoard(bad)).toThrow(/jumper must carry a link/);
  });
});

// localStorage isn't present in the Node test environment — install a minimal in-memory polyfill so the
// named-slot API is actually exercised end-to-end.
class MemStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

describe('boardStorage — named localStorage slots', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage() as unknown as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('saves, lists, loads, and deletes a slot (lossless)', () => {
    const board = bjtBoost();
    expect(saveSlot('My Boost', board)).toBe(true);
    expect(listSlots()).toEqual(['My Boost']);
    expect(loadSlot('My Boost')).toEqual(board);
    deleteSlot('My Boost');
    expect(listSlots()).toEqual([]);
    expect(loadSlot('My Boost')).toBeNull();
  });

  it('lists multiple slots sorted, and overwrites on re-save', () => {
    saveSlot('zeta', bjtBoost());
    saveSlot('alpha', bjtBoost());
    expect(listSlots()).toEqual(['alpha', 'zeta']);
    // overwrite alpha with a different board; still one entry, new contents
    const divider = PREMADE_CIRCUITS.find((c) => c.id === 'divider')!.build();
    saveSlot('alpha', divider);
    expect(listSlots()).toEqual(['alpha', 'zeta']);
    expect(loadSlot('alpha')).toEqual(divider);
  });

  it('loadSlot returns null for an absent slot', () => {
    expect(loadSlot('nope')).toBeNull();
  });

  it('saveSlot rejects an empty name', () => {
    expect(() => saveSlot('   ', bjtBoost())).toThrow(/non-empty slot name/);
  });

  it('loadSlot surfaces corrupt stored data as an error', () => {
    localStorage.setItem('bb.board.broken', '{ not json ]');
    expect(() => loadSlot('broken')).toThrow(/Not valid board JSON/);
  });
});
