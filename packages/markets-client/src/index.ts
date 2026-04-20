// Public surface for @haltmarket/markets-client.
//
// Phase 3: bin-ladder helpers.
// Phase 4: bet validation + error mapping for the place-bet edge function.
// Phase 5 will add the resolver client.

export { computeBinLadder, findBinForPrice, TAIL_HIGH_MAX } from './ladder.js';
export type { Bin } from './ladder.js';

export {
  BetError,
  BET_ERROR_STATUS,
  hasAtMost4Decimals,
  mapRpcError,
  validateBetRequest,
} from './bet.js';
export type { BetErrorCode, BetReceipt, BetRequest } from './bet.js';

export type { MarketStatus, BetStatus } from '@haltmarket/shared-types';
