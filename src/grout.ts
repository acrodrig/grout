import { isHttpMethod, Status } from "std/http/mod.ts";
import { contentType } from "std/media_types/mod.ts";

// Special variables are body, request, session, session

// deno-lint-ignore ban-types
export type Controller = Object;

// deno-lint-ignore ban-types
type Handler = Function;

/**
 * Route embedded in class method
 */
type Route = {
  method: string;
  pattern: URLPattern;
  handler: Handler;
  parameters: Record<string, unknown>;
};

const cache = new Map<Controller, Route[]>();

function kebabCase(value: string): string {
  return value.replace(/([A-Z])/g, (match: string) => "-" + match.toLowerCase());
}

// Using balanced parenthesis
function getParameters(fn: Handler): { [name: string]: unknown } {
  let source = fn.toString();

  // Remove comments /* ... */ and //
  source = source.replace(/(\/\*[\s\S]*?\*\/)|(\/\/(.)*)/g, "");

  // Find first parenthesis and then go to the end making sure we balance them
  const s = source.indexOf("(") + 1;
  let e = s, count = 1;
  for (; e < source.length; e++) {
    const char = source.charAt(e);
    if (char == "(") count++;
    if (char == ")") count--;
    if (count === 0) break;
  }

  // Get parameters, build parameters
  const tokens = source.substring(s, e).split(","), parameters: { [key: string]: unknown } = {};

  // Extract defaults
  for (const token of tokens) {
    const p = token.indexOf("=");
    const potentialValue = token.substring(p + 1).trim();
    const name = p === -1 ? token.trim() : token.substring(0, p).trim();
    const value = p === -1 || potentialValue === "undefined" ? undefined : JSON.parse(potentialValue);
    if (name) parameters[name] = value;
  }

  return parameters;
}

export function extractRoutes(controller: Controller, base: string): Route[] {
  // Are they already in the cache?
  let routes = cache.get(controller);
  if (routes) return routes;

  // Initialize to an empty array
  routes = [];
  // const proto = Object.getPrototypeOf(controller);
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(controller))) {
    const property = (controller as any)[name];
    if (name === "constructor" || !(property instanceof Function)) continue;
    const handler = property as Handler;

    // Split the function name and gather its pieces
    const parts = name.replace("$$", ".").replace("$", ":").split("_");
    const method = parts.shift()!.toUpperCase();

    // Route is only valid if it starts with a valid method
    if (!isHttpMethod(method)) continue;

    const pathname = base + (parts.length ? "/" : "") + parts.join("/");
    const pattern = new URLPattern({ pathname });
    const parameters = getParameters(handler);
    routes.push({ method, pattern, handler, parameters });
  }
  cache.set(controller, routes);
  return routes;
}

function matchRoutes(controller: Controller, base: string, url: string): Record<string, Route> {
  const routes = extractRoutes(controller, base);
  const matches: Record<string, Route> = {};
  for (const route of routes) {
    const match = route.pattern.test(url);
    if (match) matches[route.method] = route;
  }
  return matches;
}

function validate(requestParameters: Record<string, unknown>, functionParameters: Record<string, unknown>): Record<string, unknown> {
  // Will store the final parameters
  const parameters = Object.assign({}, functionParameters);

  // Check that all parameters are defined
  for (const fpn of Object.keys(functionParameters)) {
    const fpv = functionParameters[fpn];
    const rpv = requestParameters[fpn] || requestParameters[kebabCase(fpn)];

    // Check if the parameter is required
    if (fpv === undefined && rpv === undefined) {
      throw new Deno.errors.InvalidData("Parameter '" + fpn + "' is required");
    }

    const isDefined = rpv !== undefined;

    // Simple case
    parameters[fpn] = rpv;

    // Check if it is correctly a boolean
    if (typeof fpv === "boolean" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'boolean'";
      if (rpv !== "true" && rpv !== "false") throw new Deno.errors.InvalidData(message);
      else parameters[fpn] = rpv === "true";
    }

    // Check if it is correctly a number
    if (typeof fpv === "number" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'number'";
      const n = parseInt(String(rpv));
      if (Number.isNaN(n)) throw new Deno.errors.InvalidData(message);
      else parameters[fpn] = n;
    }

    // Check if it is correctly an object
    if (typeof fpv === "object" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'object'";
      try {
        parameters[fpn] = JSON.parse(String(rpv));
      } catch (ex) {
        console.error(ex);
        throw new Deno.errors.InvalidData(message);
      }
    }
  }

  return parameters;
}

let currentUserChecker = function (_request: Request): Promise<unknown> {
  return Promise.resolve(undefined);
};

export function setCurrentUserChecker<U>(cuc: (request: Request) => Promise<U>) {
  currentUserChecker = cuc;
}

export async function loadControllers(path: string): Promise<Map<string, { new (): Controller }>> {
  const map = new Map<string, { new (): Controller }>();
  const base = new URL(path, import.meta.url);
  const files = Deno.readDirSync(base);
  for (const file of files) {
    if (!file.isFile || !file.name.endsWith(".ts")) continue;
    const url = new URL(base + "/" + file.name);
    const module = await import(url.toString());
    map.set(file.name, module.default);
    if (!module) throw new Error(`No module for controller file '${file.name}'`);
  }
  return map;
}

// Will return a middleware that takes `ctx` as a single parameter
export async function handle(controller: Controller, request: Request, base?: string) {
  let ct = contentType("json");

  // If there is no base, assign the kebab version of the controller name
  if (!base) base = "/" + kebabCase(controller.constructor.name);

  // Get a list of all matching routes
  const map = matchRoutes(controller, base, request.url);
  const route = map[request.method];
  if (!route && Object.keys(map).length) {
    const status = Status.MethodNotAllowed;
    const error = "A route exists for this URL, but not for method '" + request.method + "'";
    return new Response(JSON.stringify({ error }), { status, headers: { "content-type": ct } });
  }
  if (!route) return undefined;

  const match = route.pattern.exec(request.url);
  const functionParameters: Record<string, unknown> = route.parameters;
  const requestParameters: Record<string, unknown> = Object.assign({}, match?.search.groups, match?.pathname.groups);

  // Assign request
  requestParameters.request = request;

  // Extract extension
  const parts = request.url.split(".");
  const extension = parts.length > 1 ? parts.pop() : undefined;

  // Add special variables "body" if needed
  if (Object.hasOwn(functionParameters, "body")) {
    requestParameters.body = await request.json();
  }

  // Now user if applicable
  if (Object.hasOwn(functionParameters, "user")) {
    requestParameters.user = await currentUserChecker(request);
  }

  try {
    const parameters = validate(requestParameters, functionParameters!);
    let body = await route.handler.apply(controller, Object.values(parameters));
    if (body instanceof Response) return body;
    // console.log("grout.ts[193] extension: ", extension);
    if (extension) ct = contentType(extension) ?? extension;
    else if (typeof body === "string") ct = contentType("html");
    else if (body instanceof ArrayBuffer) ct = contentType("bin");
    else body = JSON.stringify(body);
    return new Response(body, { status: Status.OK, headers: { "content-type": ct } });
  } catch (ex) {
    let status = Status.InternalServerError;
    if (ex instanceof Deno.errors.AlreadyExists) status = Status.Conflict;
    if (ex instanceof Deno.errors.InvalidData) status = Status.BadRequest;
    if (ex instanceof Deno.errors.NotFound) status = Status.NotFound;
    if (ex instanceof Deno.errors.NotSupported) status = Status.NotImplemented;
    if (status === Status.InternalServerError) console.error(ex);
    return new Response(JSON.stringify({ error: ex.message }), { status, headers: { "content-type": ct } });
  }
}
