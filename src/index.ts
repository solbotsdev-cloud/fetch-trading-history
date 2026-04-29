import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { KeyPool } from "./rateLimiter.js";
import { HeliusClient } from "./heliusClient.js";
import { fetchSignatures } from "./fetchSignatures.js";
import { fetchTransactions } from "./fetchTransactions.js";
import { extractAccountKeys, isPumpFunTradeTx } from "./pumpFunFilter.js";
import { parsePumpFunTrade } from "./parsePumpFunTrade.js";
import { groupTrades } from "./groupTrades.js";
import { buildTradeRecords } from "./formatOutput.js";
import { PhaseBar } from "./progress.js";
import {
  appendCheckpoint,
  loadCheckpoint,
  type CheckpointEntry,
} from "./checkpoint.js";
import type {
  FullTransaction,
  ParsedTradeEvent,
  RunSummary,
  TradeRecord,
} from "./types.js";

async function main(): Promise<void> {
  // ---- Phase 1: config ----------------------------------------------------
  console.log("[1/6] Loading config...");
  const cfg = loadConfig();
  console.log(
    `       wallet=${cfg.targetWallet}  hours=${cfg.hoursBack}  keys=${cfg.heliusApiKeys.length}  rate=${cfg.rateLimitPerKey}/key`,
  );
  console.log(
    `       checkpoint=${cfg.eventsCheckpointFile}  flushEvery=${cfg.writeIntervalSec}s  chunk=${cfg.txChunkSize}`,
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
    await writeOutputAtomic(cfg.outputFile, []);
    printSummary({
      targetWallet: cfg.targetWallet,
      hoursBack: cfg.hoursBack,
      signaturesFetched: 0,
      transactionsFetched: 0,
      pumpTradeTxKept: 0,
      ignoredNonTradeTx: 0,
      ignoredTransferOrNonPumpTx: 0,
      buyEvents: 0,
      sellEvents: 0,
      tradeRecords: 0,
      fullyExited: 0,
      unfinished: 0,
      outputFile: cfg.outputFile,
    });
    console.log("No trading activity found in the requested window.");
    return;
  }

  // ---- Phase 3: load checkpoint, decide what's left ----------------------
  console.log("[3/6] Loading checkpoint...");
  const checkpoint = await loadCheckpoint(cfg.eventsCheckpointFile);
  // Only consider checkpoint entries whose sig is still inside our current
  // hoursBack window. This keeps trades.json scoped to the requested range
  // even if the user shrinks hoursBack between runs.
  const sigSet = new Set(signatures.map((s) => s.signature));
  const usableCheckpoint = checkpoint.filter((c) => sigSet.has(c.sig));
  const processedSigs = new Set(usableCheckpoint.map((c) => c.sig));
  const allEvents: ParsedTradeEvent[] = usableCheckpoint.flatMap((c) => c.events);
  let pumpKept = usableCheckpoint.filter((c) => c.kept).length;
  let ignoredNonPump = usableCheckpoint.filter((c) => !c.kept).length;
  console.log(
    `       loaded ${checkpoint.length} entries (${usableCheckpoint.length} in window, ${allEvents.length} cached events)`,
  );

  const todo = signatures.filter((s) => !processedSigs.has(s.signature));
  console.log(`       ${todo.length} signatures remaining to fetch`);

  // ---- Phase 4: streaming fetch + filter + parse, with periodic flush ----
  let txOk = 0;
  let txErr = 0;
  let parseErrors = 0;
  const rejectedProgramFreq = new Map<string, number>();

  if (todo.length > 0) {
    console.log(`[4/6] Fetching/filtering/parsing ${todo.length} tx in chunks of ${cfg.txChunkSize}...`);
    const procBar = new PhaseBar({
      label: "Processing tx",
      total: signatures.length,
      showKey: true,
      showRetries: true,
    });
    procBar.update(processedSigs.size);

    const concurrency = Math.max(1, Math.floor(cfg.heliusApiKeys.length * cfg.rateLimitPerKey * 0.9));
    let processedDone = processedSigs.size;
    let lastJsonWriteMs = Date.now();
    const writeIntervalMs = cfg.writeIntervalSec * 1000;

    for (let i = 0; i < todo.length; i += cfg.txChunkSize) {
      const chunk = todo.slice(i, i + cfg.txChunkSize);
      const baseDone = processedDone;

      const fetched = await fetchTransactions(client, {
        signatures: chunk,
        concurrency,
        onTick: (done, _total, retries, lastKeyIndex) => {
          procBar.update(baseDone + done, {
            keyIndex: lastKeyIndex + 1,
            keyTotal: cfg.heliusApiKeys.length,
            retries,
            label: "Processing tx",
          });
        },
      });

      // Filter + parse this chunk synchronously, building checkpoint entries.
      const newEntries: CheckpointEntry[] = [];
      for (const f of fetched) {
        if (!f.tx) {
          txErr++;
          newEntries.push({ sig: f.signature, kept: false, events: [] });
          continue;
        }
        txOk++;
        const filterResult = isPumpFunTradeTx(f.tx, {
          pumpFunProgramIds: cfg.pumpFunProgramIds,
          pumpFunEventAuthority: cfg.pumpFunEventAuthority,
          pumpFunFeeRecipient: cfg.pumpFunFeeRecipient,
        });
        if (!filterResult.isPumpFunTrade) {
          ignoredNonPump++;
          collectProgramFreq(f.tx, rejectedProgramFreq);
          newEntries.push({ sig: f.signature, kept: false, events: [] });
          continue;
        }
        pumpKept++;
        let events: ParsedTradeEvent[] = [];
        try {
          const parseResult = parsePumpFunTrade(f.tx, f.signature, {
            targetWallet: cfg.targetWallet,
            minSolChange: cfg.minSolChange,
            minTokenChange: cfg.minTokenChange,
          });
          events = parseResult.events;
        } catch (err) {
          parseErrors++;
          console.error(`\n       parse error for ${f.signature}: ${err instanceof Error ? err.message : String(err)}`);
        }
        newEntries.push({ sig: f.signature, kept: true, events });
        if (events.length > 0) allEvents.push(...events);
      }

      // Append-only checkpoint flush — durably records that this chunk has
      // been processed. After this point, a crash + restart will skip it.
      await appendCheckpoint(cfg.eventsCheckpointFile, newEntries);

      processedDone += chunk.length;
      procBar.update(processedDone, {
        keyIndex: 0,
        keyTotal: cfg.heliusApiKeys.length,
        retries: client.stats.retries,
        label: "Processing tx",
      });

      // Periodic trades.json rewrite so the user can monitor progress mid-run.
      // Atomic (tmp + rename) so a kill mid-write can't corrupt the file.
      const now = Date.now();
      if (now - lastJsonWriteMs >= writeIntervalMs) {
        await flushTradesJson(allEvents, cfg.outputFile);
        lastJsonWriteMs = now;
        process.stdout.write(
          `\n       [periodic flush @ ${new Date(now).toISOString()}] ${allEvents.length} events → ${cfg.outputFile}\n`,
        );
      }
    }

    procBar.stop();
    console.log(
      `       processed ${processedDone}/${signatures.length} sigs  (txOk=${txOk}, txErr=${txErr}, kept=${pumpKept}, non-pump=${ignoredNonPump}, parseErrors=${parseErrors})`,
    );

    if (pumpKept === 0 && ignoredNonPump > 0) {
      const top = [...rejectedProgramFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log("       diagnostic: top programs in rejected tx (program -> count):");
      for (const [pid, n] of top) console.log(`         ${pid}  -> ${n}`);
      console.log(`       (set PUMP_FUN_PROGRAM_ID="id1,id2,..." in .env to add programs)`);
    }
  } else {
    console.log("[4/6] All signatures already processed in checkpoint — skipping fetch.");
  }

  // ---- Phase 5: final group + write --------------------------------------
  console.log("[5/6] Grouping buy lots and writing final output...");
  const records = await flushTradesJson(allEvents, cfg.outputFile);
  const fullyExited = records.filter((r) => r.exit.fullyExited).length;
  const unfinished = records.length - fullyExited;
  const buyEvents = allEvents.filter((e) => e.type === "BUY").length;
  const sellEvents = allEvents.filter((e) => e.type === "SELL").length;
  console.log(`       ${records.length} trade records  (fully exited=${fullyExited}, unfinished=${unfinished})`);

  // ---- Phase 6: summary --------------------------------------------------
  // pumpKept + ignoredNonPump = sigs for which we have tx data on disk
  // (this run's successful fetches + everything in the resumable checkpoint).
  // txErr counts only this-run fetch failures; resumed-run failures aren't
  // re-tracked, which is fine because they're long since retried.
  printSummary({
    targetWallet: cfg.targetWallet,
    hoursBack: cfg.hoursBack,
    signaturesFetched: signatures.length,
    transactionsFetched: pumpKept + ignoredNonPump,
    pumpTradeTxKept: pumpKept,
    ignoredNonTradeTx: txErr,
    ignoredTransferOrNonPumpTx: ignoredNonPump,
    buyEvents,
    sellEvents,
    tradeRecords: records.length,
    fullyExited,
    unfinished,
    outputFile: cfg.outputFile,
  });
}

async function flushTradesJson(
  events: ParsedTradeEvent[],
  outputFile: string,
): Promise<TradeRecord[]> {
  const sorted = [...events].sort((a, b) => a.blockTime - b.blockTime);
  const lots = groupTrades(sorted);
  const records = buildTradeRecords(lots);
  validateRecords(records);
  await writeOutputAtomic(outputFile, records);
  return records;
}

async function writeOutputAtomic(outputFile: string, records: TradeRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const json = JSON.stringify(records, null, 2);
  JSON.parse(json); // round-trip guarantee
  // Atomic write: pour into a sibling tmp file then rename. If we get killed
  // mid-write, the original trades.json remains intact.
  const tmp = `${outputFile}.tmp-${process.pid}`;
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, outputFile);
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
    if (r.pattern.sellCount !== r.sells.length) {
      throw new Error(`pattern.sellCount mismatch on trade ${r.tradeNumber}`);
    }
    const expectedSeq = r.sells.map((s) => s.pct);
    if (r.pattern.sequence.length !== expectedSeq.length ||
        r.pattern.sequence.some((v, k) => v !== expectedSeq[k])) {
      throw new Error(`pattern.sequence != sells.map(pct) on trade ${r.tradeNumber}`);
    }
    if (r.exit.fullyExited && r.sells.length > 0) {
      const sumPct = r.sells.reduce((acc, s) => acc + s.pct, 0);
      if (Math.abs(sumPct - 100) > 5) {
        throw new Error(`fully exited trade ${r.tradeNumber} pct sum=${sumPct}, expected ~100`);
      }
    }
  }
}

function printSummary(s: RunSummary): void {
  console.log("");
  console.log("==================== Run Summary ====================");
  console.log(`Target wallet            : ${s.targetWallet}`);
  console.log(`Hours back               : ${s.hoursBack}`);
  console.log(`Signatures fetched       : ${s.signaturesFetched}`);
  console.log(`Transactions fetched     : ${s.transactionsFetched}`);
  console.log(`Pump.fun trade tx kept   : ${s.pumpTradeTxKept}`);
  console.log(`Ignored non-trade tx     : ${s.ignoredNonTradeTx}`);
  console.log(`Ignored transfer/non-Pump: ${s.ignoredTransferOrNonPumpTx}`);
  console.log(`Buy events               : ${s.buyEvents}`);
  console.log(`Sell events              : ${s.sellEvents}`);
  console.log(`Trade records            : ${s.tradeRecords}`);
  console.log(`  fully exited           : ${s.fullyExited}`);
  console.log(`  unfinished             : ${s.unfinished}`);
  console.log(`Output file              : ${s.outputFile}`);
  console.log("=====================================================");
}

function collectProgramFreq(tx: FullTransaction, freq: Map<string, number>): void {
  const keys = extractAccountKeys(tx);
  const seen = new Set<string>();
  const visit = (ix: { programId?: string; programIdIndex?: number }): void => {
    let pid: string | undefined;
    if (typeof ix.programId === "string") pid = ix.programId;
    else if (typeof ix.programIdIndex === "number") pid = keys[ix.programIdIndex];
    if (pid) seen.add(pid);
  };
  for (const ix of tx.transaction.message.instructions ?? []) visit(ix);
  const inner = tx.meta?.innerInstructions ?? [];
  for (const group of inner as Array<{ instructions?: Array<{ programId?: string; programIdIndex?: number }> }>) {
    for (const ix of group.instructions ?? []) visit(ix);
  }
  for (const pid of seen) freq.set(pid, (freq.get(pid) ?? 0) + 1);
}

main().catch((err) => {
  console.error("");
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
