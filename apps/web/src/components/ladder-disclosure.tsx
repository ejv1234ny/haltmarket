'use client';

import { useState } from 'react';
import type { MockMarket } from '@/lib/mocks/types';
import { BinLadder } from './bin-ladder';

// ADR-0002 §Phase 7: the full 20-bin ladder is a power-user disclosure, not
// a primary affordance. New users stay in the "guess the price" flow.
export function LadderDisclosure({ market }: { market: MockMarket }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start text-xs font-medium text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
        data-testid="ladder-toggle"
      >
        {open ? 'Hide ladder' : 'Show ladder (20 bins)'}
      </button>
      {open && <BinLadder market={market} />}
    </div>
  );
}
