import { type JsonValue } from "std/json/mod.ts";
import { getLogger, handlers, setup } from "std/log/mod.ts";

setup({
  handlers: { console: new handlers.ConsoleHandler("DEBUG") },
  loggers: { grout: { level: "INFO", handlers: ["console"] } },
});

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

  async go(method: string, url: string, data?: string | URLSearchParams | JsonValue, logOff = false, headers = {}): Promise<Response> {
    const log = getLogger("grout");
    if (logOff) log.levelName = "CRITICAL";
    headers = Object.assign({ "content-Type": typeof data === "string" ? "text/plain" : "application/json" }, headers);
    const options: RequestInit = { method, headers };
    options.body = typeof data === "string" || data instanceof URLSearchParams ? data : JSON.stringify(data);
    const response = await fetch(new URL(url, this.base), options);
    if (response.status === 204 || options.method === "HEAD") response.data = "";
    else if (response.headers.get("Content-Type")?.includes("application/json")) response.data = await response.json();
    else response.data = await response.text();
    if (logOff) log.levelName = "INFO";
    return response;
  }
}
