// Public surface for @haltmarket/markets-client.
//
// Phase 3 exports the bin-ladder helpers; Phase 4 will add place-bet wrappers
// around the `place-bet` edge function; Phase 5 will add the resolver client.

export { computeBinLadder, findBinForPrice, TAIL_HIGH_MAX } from './ladder.js';
export type { Bin } from './ladder.js';

export type { MarketStatus, BetStatus } from '@haltmarket/shared-types';
