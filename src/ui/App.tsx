/**
 * Top-level shell: a tab toggle between the hand-build eyelet BOARD and the guided EXAMPLES
 * (the six starter circuits). Switching tabs unmounts the other panel, which stops its audio.
 */

import { useState } from 'react';
import { Board } from './board/Board';
import { CircuitDemo } from './CircuitDemo';

export function App() {
  const [tab, setTab] = useState<'build' | 'examples'>('build');
  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">BoardBuilder</span>
        <div className="tabs">
          <button className={tab === 'build' ? 'on' : ''} onClick={() => setTab('build')}>
            Build
          </button>
          <button className={tab === 'examples' ? 'on' : ''} onClick={() => setTab('examples')}>
            Examples
          </button>
        </div>
      </div>
      {tab === 'build' ? <Board /> : <CircuitDemo />}
    </div>
  );
}
