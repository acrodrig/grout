import { type JsonValue } from "std/json/mod.ts";

declare global {
  export interface Response {
    data: any;
  }
}

export class Fetcher {
  base = "";

  constructor(base: string) {
    this.base = base;
  }

  async go(method: string, url: string, data?: string | JsonValue) {
    const options: RequestInit = { method };
    if (typeof (data) !== "string") options.headers = { "Content-Type": "application/json" };
    options.body = typeof (data) === "string" ? data : JSON.stringify(data);
    const response = await fetch(new URL(url, this.base), options);
    if (response.status === 204 || options.method === "HEAD") response.data = "";
    else if (response.headers.get("Content-Type")?.includes("application/json")) response.data = await response.json();
    else response.data = await response.text();
    return response;
  }
}
