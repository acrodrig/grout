import { type JsonValue } from "@std/json";
import { ConsoleHandler, getLogger, setup } from "@std/log";

const PROVIDER = Deno.env.get("TEST_PROVIDER") ?? Deno.args[0];
if (!PROVIDER) console.warn("\n⚠️  Assuming specification from TYPES provider. You can use 'TEST_PROVIDER=<provider>' or '-- <provider>' (source, types)\n");

setup({
  handlers: { console: new ConsoleHandler("DEBUG") },
  loggers: { grout: { level: "INFO", handlers: ["console"] } },
});

export const getProvider = function () {
  const provider = PROVIDER;
  if (provider && !["source", "types"].includes(provider.toLowerCase())) {
    console.error("\n❌ Specification provider '" + provider + "' does not exist!\n");
    Deno.exit(1);
  }
  return (provider || "types").toLowerCase();
};

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
