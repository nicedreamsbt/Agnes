import fs from "fs";
import path from "path";

const MAX_QUEUE = 2000;

function jsonReplacer(_k, v) {
  if (typeof v === "bigint") return v.toString();
  return v;
}

/**
 * @param {number | undefined} index
 * @param {string | undefined} label
 * @param {string | undefined} program
 */
export function formatFailedAtBanner(index, label, program) {
  return `\nFAILED_AT:\nindex=${index ?? "?"}\nlabel=${label ?? "?"}\nprogram=${program ?? "?"}\n`;
}

/**
 * @param {object} cfg
 * @returns {LiqAttemptLogger | null}
 */
export function createLiqAttemptLogger(cfg) {
  if (!cfg.agnesLiqDebug) return null;
  return new LiqAttemptLogger(cfg);
}

export class LiqAttemptLogger {
  /** @param {object} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    const root = process.cwd();
    this.logsDir = path.join(root, "logs");
    this.debugDir = path.join(root, "debug");
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(this.debugDir, { recursive: true });
    /** @type {{ stream: import("fs").WriteStream, data: string }[]} */
    this.queue = [];
    /** @type {boolean} */
    this._pumping = false;
    /** @type {boolean} */
    this._dropWarned = false;

    this.attemptsStream = fs.createWriteStream(path.join(this.logsDir, "liquidation_attempts.log"), {
      flags: "a",
    });
    this.failuresStream = fs.createWriteStream(path.join(this.logsDir, "liquidation_failures.log"), {
      flags: "a",
    });
    const onErr = (which) => (err) => console.error(`[liq-debug] ${which} stream:`, err?.message || err);
    this.attemptsStream.on("error", onErr("attempts"));
    this.failuresStream.on("error", onErr("failures"));
  }

  /**
   * @param {object} entry
   */
  logAttemptEntry(entry) {
    const line = JSON.stringify(entry, jsonReplacer) + "\n";
    this._enqueue(this.attemptsStream, line);
  }

  /**
   * @param {object} entry failure snapshot (JSON)
   * @param {string} [extraText] e.g. FAILED_AT banner
   */
  logFailureEntry(entry, extraText = "") {
    const line = JSON.stringify(entry, jsonReplacer) + "\n" + (extraText || "");
    this._enqueue(this.failuresStream, line);
  }

  /**
   * @param {object} payload
   */
  writeDebugExport(payload) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fp = path.join(this.debugDir, `liquidation_attempt_${ts}.json`);
    void fs.promises
      .writeFile(fp, JSON.stringify(payload, jsonReplacer, 2), "utf8")
      .catch((e) => console.error("[liq-debug] debug export:", e?.message || e));
  }

  /**
   * @param {import("fs").WriteStream} stream
   * @param {string} data
   */
  _enqueue(stream, data) {
    if (this.queue.length >= MAX_QUEUE) {
      if (!this._dropWarned) {
        console.error("[liq-debug] log queue overflow; dropping further entries until drained");
        this._dropWarned = true;
      }
      return;
    }
    this.queue.push({ stream, data });
    void this._pump();
  }

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.queue.length > 0) {
        const { stream, data } = this.queue.shift();
        await new Promise((resolve, reject) => {
          try {
            stream.write(data, (err) => (err ? reject(err) : resolve()));
          } catch (e) {
            reject(e);
          }
        }).catch((e) => console.error("[liq-debug] write:", e?.message || e));
      }
    } finally {
      this._pumping = false;
      if (this.queue.length > 0) void this._pump();
    }
  }
}
