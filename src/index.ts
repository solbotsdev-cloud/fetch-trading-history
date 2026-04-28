import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { KeyPool } from "./rateLimiter.js";
import { HeliusClient } from "./heliusClient.js";
import { fetchSignatures } from "./fetchSignatures.js";
import { fetchTransactions } from "./fetchTransactions.js";
import { parseTradeEventsFromTx } from "./parseTradeEvents.js";
import { groupTrades } from "./groupTrades.js";
import { buildTradeRecords } from "./formatOutput.js";
import { PhaseBar } from "./progress.js";
import type { ParsedTradeEvent, RunSummary, TradeRecord } from "./types.js";

async function main(): Promise<void> {
  console.log("[1/6] Loading config...");
  const cfg = loadConfig();
  console.log(
    `       wallet=${cfg.targetWallet}  hours=${cfg.hoursBack}  keys=${cfg.heliusApiKeys.length}  rate=${cfg.rateLimitPerKey}/key`,
  );

  const pool = new KeyPool(cfg.heliusApiKeys, cfg.rateLimitPerKey);
  const client = new HeliusClient(pool);

  // ---- Phase 2: signatures ------------------------------------------------
  console.log("[2/6] Fetching signatures...");
  const sigBar = new PhaseBar({ label: "Signatures collected", total: 1, showKey: false, showRetries: true });
  let lastSigCount = 0;
  const signatures = await fetchSignatures(client, {
    walletAddress: cfg.targetWallet,
    hoursBack: cfg.hoursBack,
    onProgress: (count) => {
      lastSigCount = count;
      sigBar.setTotal(Math.max(count, 1));
      sigBar.update(count, { retries: client.stats.retries, label: "Signatures collected" });
    },
  });
  sigBar.setTotal(Math.max(signatures.length, 1));
  sigBar.update(signatures.length, { retries: client.stats.retries, label: "Signatures collected" });
  sigBar.stop();
  console.log(`       collected ${signatures.length} signatures (last in-flight count ${lastSigCount})`);

  if (signatures.length === 0) {
    const summary: RunSummary = {
      targetWallet: cfg.targetWallet,
      hoursBack: cfg.hoursBack,
      signaturesFetched: 0,
      transactionsParsed: 0,
      buyEvents: 0,
      sellEvents: 0,
      tradeRecords: 0,
      fullyExited: 0,
      unfinished: 0,
      outputFile: cfg.outputFile,
    };
    await writeOutput(cfg.outputFile, []);
    printSummary(summary);
    console.log("No trading activity found in the requested window.");
    return;
  }

  // ---- Phase 3: transactions ---------------------------------------------
  console.log("[3/6] Fetching transactions...");
  const txBar = new PhaseBar({
    label: "Fetching tx",
    total: signatures.length,
    showKey: true,
    showRetries: true,
  });

  // Tune concurrency: total budget roughly equals (keys * rate-per-key), but
  // cap a bit lower to leave headroom for retries and bursts.
  const concurrency = Math.max(1, Math.floor(cfg.heliusApiKeys.length * cfg.rateLimitPerKey * 0.9));

  const fetched = await fetchTransactions(client, {
    signatures,
    concurrency,
    onTick: (done, total, retries, lastKeyIndex) => {
      txBar.update(done, {
        keyIndex: lastKeyIndex + 1,
        keyTotal: cfg.heliusApiKeys.length,
        retries,
        label: "Fetching tx",
      });
    },
  });
  txBar.stop();
  const txOk = fetched.filter((f) => f.tx !== null).length;
  const txErr = fetched.length - txOk;
  console.log(`       fetched ${txOk} transactions, ${txErr} errors, retries=${client.stats.retries}`);

  // ---- Phase 4: parse -----------------------------------------------------
  console.log("[4/6] Parsing trade events...");
  const parseBar = new PhaseBar({ label: "Parsing tx", total: fetched.length });
  const events: ParsedTradeEvent[] = [];
  const stats = {
    parsed: 0,
    skippedNoMeta: 0,
    skippedNoTime: 0,
    skippedNotPump: 0,
    skippedNoTrade: 0,
    errors: 0,
  };

  for (let i = 0; i < fetched.length; i++) {
    const f = fetched[i]!;
    if (!f.tx) {
      stats.errors++;
      parseBar.update(i + 1);
      continue;
    }
    try {
      const result = parseTradeEventsFromTx(f.tx, f.signature, {
        targetWallet: cfg.targetWallet,
        pumpProgramIds: cfg.pumpProgramIds,
        minSolChange: cfg.minSolChange,
        minTokenChange: cfg.minTokenChange,
      });
      if (result.events.length > 0) {
        events.push(...result.events);
        stats.parsed++;
      } else if (result.reason) {
        stats[result.reason]++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`\n       parse error for ${f.signature}: ${err instanceof Error ? err.message : String(err)}`);
    }
    parseBar.update(i + 1);
  }
  parseBar.stop();
  const buyEvents = events.filter((e) => e.type === "BUY").length;
  const sellEvents = events.filter((e) => e.type === "SELL").length;
  console.log(
    `       events: BUY=${buyEvents} SELL=${sellEvents}  skipped: notPump=${stats.skippedNotPump} noTrade=${stats.skippedNoTrade} noMeta=${stats.skippedNoMeta} noTime=${stats.skippedNoTime}  errors=${stats.errors}`,
  );

  // Sort events ascending by time so FIFO grouping is correct.
  events.sort((a, b) => a.blockTime - b.blockTime);

  // ---- Phase 5: group -----------------------------------------------------
  console.log("[5/6] Grouping buy/sell lots...");
  const lots = groupTrades(events);
  const records = buildTradeRecords(lots);
  validateRecords(records);
  const fullyExited = records.filter((r) => r.exit.fullyExited).length;
  const unfinished = records.length - fullyExited;
  console.log(`       ${records.length} trade records  (fully exited=${fullyExited}, unfinished=${unfinished})`);

  // ---- Phase 6: write -----------------------------------------------------
  console.log("[6/6] Writing output JSON...");
  await writeOutput(cfg.outputFile, records);

  printSummary({
    targetWallet: cfg.targetWallet,
    hoursBack: cfg.hoursBack,
    signaturesFetched: signatures.length,
    transactionsParsed: stats.parsed,
    buyEvents,
    sellEvents,
    tradeRecords: records.length,
    fullyExited,
    unfinished,
    outputFile: cfg.outputFile,
  });
}

async function writeOutput(outputFile: string, records: TradeRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const json = JSON.stringify(records, null, 2);
  // Round-trip parse to guarantee valid JSON before persisting.
  JSON.parse(json);
  await fs.writeFile(outputFile, json, "utf8");
}

function validateRecords(records: TradeRecord[]): void {
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.tradeNumber !== i + 1) {
      throw new Error(`tradeNumber sequence broken at index ${i}: got ${r.tradeNumber}, expected ${i + 1}`);
    }
    for (let j = 1; j < r.sells.length; j++) {
      if (r.sells[j]!.delaySec < r.sells[j - 1]!.delaySec) {
        throw new Error(`Sells not sorted by delaySec on trade ${r.tradeNumber}`);
      }
    }
  }
}

function printSummary(s: RunSummary): void {
  console.log("");
  console.log("==================== Run Summary ====================");
  console.log(`Target wallet     : ${s.targetWallet}`);
  console.log(`Hours back        : ${s.hoursBack}`);
  console.log(`Signatures fetched: ${s.signaturesFetched}`);
  console.log(`Transactions parsed: ${s.transactionsParsed}`);
  console.log(`Buy events        : ${s.buyEvents}`);
  console.log(`Sell events       : ${s.sellEvents}`);
  console.log(`Trade records     : ${s.tradeRecords}`);
  console.log(`  fully exited    : ${s.fullyExited}`);
  console.log(`  unfinished      : ${s.unfinished}`);
  console.log(`Output file       : ${s.outputFile}`);
  console.log("=====================================================");
}

main().catch((err) => {
  console.error("");
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
