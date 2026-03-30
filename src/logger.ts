import * as fs from "node:fs";

const LOG_FILE = "sitecrawl.log";
const ERROR_LOG_FILE = "sitecrawl.errors.log";

let logStream: fs.WriteStream;
let errorStream: fs.WriteStream;

function timestamp(): string {
  return new Date().toISOString();
}

export function initLogger() {
  logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
  errorStream = fs.createWriteStream(ERROR_LOG_FILE, { flags: "w" });
}

export function closeLogger() {
  logStream?.end();
  errorStream?.end();
}

export function log(message: string) {
  const line = `[${timestamp()}] ${message}`;
  console.log(message);
  logStream.write(line + "\n");
}

export function warn(message: string) {
  const line = `[${timestamp()}] WARN: ${message}`;
  console.warn(message);
  logStream.write(line + "\n");
  errorStream.write(line + "\n");
}

export function error(message: string) {
  const line = `[${timestamp()}] ERROR: ${message}`;
  console.error(message);
  logStream.write(line + "\n");
  errorStream.write(line + "\n");
}
