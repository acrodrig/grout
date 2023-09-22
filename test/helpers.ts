import { type JsonValue } from "std/json/mod.ts";
import { getLogger, handlers, LogLevels } from "std/log/mod.ts";

const logger = getLogger("grout:grout");
logger.level = LogLevels.INFO;
logger.handlers.push(new handlers.ConsoleHandler("DEBUG"));

export function logOff() {
  logger.level = LogLevels.CRITICAL;
}

export function logOn() {
  logger.level = LogLevels.INFO;
}

declare global {
  export interface Response {
    data: unknown;
  }
}

export class Fetcher {
  base = "";

  constructor(base: string) {
    this.base = base;
  }

  async go(method: string, url: string, data?: string | JsonValue, logOff = false, headers = {}): Promise<Response> {
    if (logOff) logger.level = LogLevels.CRITICAL;
    headers = Object.assign({ "Content-Type": typeof data !== "string" ? "text/plain" : "application/json" }, headers);
    const options: RequestInit = { method, headers };
    options.body = typeof data === "string" ? data : JSON.stringify(data);
    const response = await fetch(new URL(url, this.base), options);
    if (response.status === 204 || options.method === "HEAD") response.data = "";
    else if (response.headers.get("Content-Type")?.includes("application/json")) response.data = await response.json();
    else response.data = await response.text();
    if (logOff) logger.level = LogLevels.INFO;
    return response;
  }
}
