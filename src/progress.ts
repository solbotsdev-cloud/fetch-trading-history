import cliProgress from "cli-progress";

export interface PhaseBarOptions {
  label: string;
  total: number;
  showKey?: boolean;
  showRetries?: boolean;
}

export class PhaseBar {
  private bar: cliProgress.SingleBar;
  private isStopped = false;

  constructor(opts: PhaseBarOptions) {
    const fmt = buildFormat(opts);
    this.bar = new cliProgress.SingleBar(
      {
        format: fmt,
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
        etaBuffer: 50,
      },
      cliProgress.Presets.shades_classic,
    );
    this.bar.start(Math.max(1, opts.total), 0, { keyIndex: 0, keyTotal: 0, retries: 0, label: opts.label });
  }

  update(value: number, payload?: { keyIndex?: number; keyTotal?: number; retries?: number; label?: string }): void {
    if (this.isStopped) return;
    this.bar.update(value, payload as object | undefined);
  }

  setTotal(total: number): void {
    if (this.isStopped) return;
    this.bar.setTotal(Math.max(1, total));
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    this.bar.stop();
  }
}

function buildFormat(opts: PhaseBarOptions): string {
  const parts: string[] = [];
  parts.push("[{bar}] {percentage}% | {label} {value}/{total}");
  if (opts.showKey) parts.push("key {keyIndex}/{keyTotal}");
  if (opts.showRetries) parts.push("retries {retries}");
  parts.push("ETA {eta_formatted}");
  return parts.join(" | ");
}
