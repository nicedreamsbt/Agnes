import fs from "fs";

/**
 * Duplicate process stdout/stderr to a file (still echoes to the terminal).
 * Set via config `logFile` / env `LOG_FILE`.
 */
export function installLogFileTee(filePath) {
  if (!filePath || typeof filePath !== "string") return;

  const stream = fs.createWriteStream(filePath, { flags: "a" });
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
