/**
 * BiasOverlay — the optional DC-bias label layer for the board, an SVG <g> meant to be dropped INSIDE
 * the existing board <svg> (so it shares the board's mm coordinate space). For each eyelet it renders a
 * small voltage chip near the centroid: what the node sits at, in real-volt labels (the "see" half).
 *
 * Pure presentation: a function of the board geometry + the bias solve. No interaction, no DOM events.
 */

import { formatVolts } from '../../engine/units';
import { computeBias } from './biasReadout';
import type { BoardState } from './boardModel';

interface BiasOverlayProps {
  board: BoardState;
}

export function BiasOverlay({ board }: BiasOverlayProps): JSX.Element {
  const points = computeBias(board);
  return (
    <g pointerEvents="none">
      {points.map((p) => {
        const label = formatVolts(p.volts);
        // a chip offset up-right of the eyelet so it clears the gold blob; width tracks the label length
        const w = label.length * 1.35 + 1.6;
        const lx = p.x + 1.6;
        const ly = p.y - 3.4;
        return (
          <g key={p.eyeletId}>
            <rect x={lx} y={ly} width={w} height={2.8} rx={0.6} fill="#0c1a12" fillOpacity={0.85} stroke="#3ec77a" strokeWidth={0.18} />
            <text x={lx + w / 2} y={ly + 2.0} textAnchor="middle" fontSize={1.9} fill="#aef0c4" style={{ fontFamily: 'monospace' }}>
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
