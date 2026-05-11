import fs from "fs";
import path from "path";

/**
 * Duplicate process stdout/stderr to a file (still echoes to the terminal).
 * Set via config `logFile` / env `LOG_FILE`.
 */
export function installLogFileTee(filePath) {
  if (!filePath || typeof filePath !== "string") return;

  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore mkdir errors; createWriteStream may still work for cwd-relative paths */
  }

  const stream = fs.createWriteStream(resolved, { flags: "a" });
  stream.write(`\n--- ${new Date().toISOString()} monitor log ---\n`);

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = (...args) => {
    try {
      stream.write(...args);
    } catch {
      /* ignore disk errors */
    }
    return origOut(...args);
  };
  process.stderr.write = (...args) => {
    try {
      stream.write(...args);
    } catch {
      /* ignore disk errors */
    }
    return origErr(...args);
  };

  const end = () => {
    try {
      stream.write(`--- log end ${new Date().toISOString()} ---\n`);
      stream.end();
    } catch {
      /* ignore */
    }
  };
  process.once("exit", end);
}
