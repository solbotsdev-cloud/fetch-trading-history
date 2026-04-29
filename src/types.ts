export interface AppConfig {
  targetWallet: string;
  hoursBack: number;
  heliusApiKeys: string[];
  rateLimitPerKey: number;
  outputFile: string;
  eventsCheckpointFile: string;
  writeIntervalSec: number;
  txChunkSize: number;
  pumpFunProgramIds: string[];
  pumpFunEventAuthority: string;
  pumpFunFeeRecipient: string;
  minSolChange: number;
  minTokenChange: number;
}

export interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

export interface TransactionMeta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  loadedAddresses?: {
    writable?: string[];
    readonly?: string[];
  };
  innerInstructions?: unknown[];
  logMessages?: string[];
}

export interface TransactionMessage {
  accountKeys: Array<string | { pubkey: string }>;
  instructions: Array<{
    programId?: string;
    programIdIndex?: number;
  }>;
}

export interface FullTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: TransactionMessage;
  };
  meta: TransactionMeta | null;
}

export type TradeEventType = "BUY" | "SELL";

export interface ParsedTradeEvent {
  type: TradeEventType;
  signature: string;
  blockTime: number;
  mint: string;
  solAmount: number;
  tokenAmount: number;
}

export interface OpenLot {
  mint: string;
  buySignature: string;
  buyTime: number;
  buySol: number;
  originalTokenAmount: number;
  remainingTokenAmount: number;
  buyUnitPrice: number;
  totalSellSol: number;
  sells: AppliedSell[];
}

export interface AppliedSell {
  multiplier: number;
  pct: number;
  delaySec: number;
  rawPct: number;
  sellTime: number;
  sellSignature: string;
}

export interface SellRecordOut {
  multiplier: number;
  pct: number;
  delaySec: number;
  time: string;
}

export interface TradeRecord {
  tradeNumber: number;
  buy: {
    sol: number;
    tx: string;
    time: string;
  };
  sells: SellRecordOut[];
  exit: {
    fullyExited: boolean;
    exitTimeSec: number | null;
    pnlSol: number | null;
  };
  pattern: {
    sequence: number[];
    sellCount: number;
    firstMultiplier: number | null;
    durationSec: number | null;
  };
  raw: string;
}

export interface RunSummary {
  targetWallet: string;
  hoursBack: number;
  signaturesFetched: number;
  transactionsFetched: number;
  pumpTradeTxKept: number;
  ignoredNonTradeTx: number;
  ignoredTransferOrNonPumpTx: number;
  buyEvents: number;
  sellEvents: number;
  tradeRecords: number;
  fullyExited: number;
  unfinished: number;
  outputFile: string;
}
