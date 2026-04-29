import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedTradeEvent } from "./types.js";

// One line per processed signature. Append-only — on crash, we just resume
// from "first signature not in this file". `kept=false` means the tx was
// fetched but rejected by the pump-fun filter (or had no meta / failed);
// `kept=true` with empty events means parse found no matching trade.
export interface CheckpointEntry {
  sig: string;
  kept: boolean;
  events: ParsedTradeEvent[];
}

export async function loadCheckpoint(filePath: string): Promise<CheckpointEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = content.split("\n");
  const entries: CheckpointEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as CheckpointEntry);
    } catch {
      // A crash mid-write can leave a partial trailing line. Tolerate it only
      // if it's the very last non-empty line — anything earlier is real
      // corruption and shouldn't be silently dropped.
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.length === 0);
      if (!isLastNonEmpty) {
        throw new Error(`corrupt line ${i + 1} in checkpoint ${filePath}`);
      }
    }
  }
  return entries;
}

export async function appendCheckpoint(
  filePath: string,
  entries: CheckpointEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.appendFile(filePath, lines, "utf8");
}
