import { getLogger } from "std/log/mod.ts";
import { STATUS_CODE } from "std/http/mod.ts";
import { contentType } from "std/media_types/mod.ts";
import { getParametersFromAST, getParametersFromSource, typeOf } from "./reflection.ts";

// Special variables are $body, $request, $session, $user

const HTTP_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

export type Controller = {
  /**
   * Indicates the base path for all routes in this controller
   */
  base?: string;

  /**
   * URL from which the controller was loaded (could be a file URL)
   */
  url?: URL;

  /**
   * Indicates if the controller is open (i.e. no authentication required)
   */
  open?: boolean;
};

// deno-lint-ignore ban-types
type Handler = Function;

// See https://github.com/denoland/deno_std/blob/0.221.0/json/common.ts
// See https://github.com/ts-essentials/ts-essentials/blob/master/lib/primitive/index.ts
type Value = bigint | boolean | null | number | string | symbol | { [key: string]: Value | undefined } | Value[];

export interface Schema {
  $id: string;
  type?: string;
  description?: string;
  properties: Record<string, Property>;
  required: string[];
  additionalProperties?: boolean;
}

export interface Property {
  type: string;
  description?: string;
  default?: Value | undefined;
  enum?: (string | number)[];
  items?: { type: string };
  minimum?: number;
}

/**
 * Route embedded in class method
 */
type Route = {
  pathname: string;
  method: string;
  pattern: URLPattern;
  handler: Handler;
  schema: Schema;
};

const cache = new Map<Controller, Route[]>();

// Utility function to convert camelCase to kebab-case
function kebabCase(value: string): string {
  return value.replace(/([A-Z])/g, (match: string) => "-" + match.toLowerCase());
}

// Utility function to chop optional quotes surrounding a string
function chopQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").replace(/^"(.*)"$/, "$1");
}

// Get parameters from AST or source
function getParameters(fn: Function, fileName?: string) {
  return fileName ? getParametersFromAST(fileName, fn) : getParametersFromSource(fn);
}

export function extractRoutes(controller: Controller, base = controller.base): Route[] {
  // Are they already in the cache?
  let routes = cache.get(controller);
  if (routes) return routes;

  // Initialize to an empty array
  routes = [];

  // Get the prototype names (all) and add the owned names
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(controller));
  for (const on of Object.getOwnPropertyNames(controller)) {
    if (!names.includes(on)) names.push(on);
  }

  // Iterate over all names
  for (const name of names) {
    const property = (controller as any)[name];
    if (name === "constructor" || !(property instanceof Function)) continue;
    const handler = property as Handler;

    // Split the function name and gather its pieces
    const parts = name.replace("_$_", ".").replace("$", ":").split("_");
    const method = parts.shift()!.toUpperCase();

    // Route is only valid if it starts with a valid method
    if (!HTTP_METHODS.includes(method)) continue;

    const pathname = base + (parts.length ? "/" : "") + parts.join("/");
    const pattern = new URLPattern({ pathname });
    const schema = getParameters(handler, decodeURI(controller.url?.pathname ?? ""))!;
    routes.push({ pathname, method, pattern, handler, schema });
  }

  // More specific routes (with fewer parameters) should be first, longer routes should be first
  routes.sort((r1, r2) => {
    const p1 = r1.pathname.split(":").length - 1;
    const p2 = r2.pathname.split(":").length - 1;
    if (p1 != p2) return p1 - p2;
    return r2.pathname.length - r1.pathname.length;
  });

  cache.set(controller, routes);
  return routes;
}

function matchRoute(controller: Controller, method: string, url: string, base = controller.base) {
  const routes = extractRoutes(controller, base);
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.test(url);
    if (match) return route;
  }
  return undefined;
}

function countRoutes(controller: Controller, url: string, base = controller.base): number {
  const routes = extractRoutes(controller, base);
  let count = 0;
  for (const route of routes) {
    if (route.pattern.test(url)) count++;
  }
  return count;
}

// Returns parameters to invoke handler with, and it will fill with defaults if needed
// The `parameters` object is potentially full of the strings found in the URL
function validate(parameters: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const logger = getLogger("grout");

  // Check that all parameters are defined
  for (const name of Object.keys(schema.properties)) {
    const property = schema.properties[name];
    const defaultValue = property.default;
    const value = parameters[name] ?? parameters[kebabCase(name)];

    // Check if the parameter is required
    if (schema.required.includes(name) && value === undefined) {
      logger.warn({ method: "validate", parameter: name, condition: "REQUIRED" });
      throw new Deno.errors.InvalidData("Parameter '" + name + "' is required");
    }

    const expectedType = property.type;

    if (value == undefined) parameters[name] = defaultValue;
    else if (expectedType === "string") parameters[name] = chopQuotes(value as string);
    else {
      try {
        parameters[name] = typeof(value) === "string" ? JSON.parse(value as string) : value;
      } catch (_ex) {
        logger.warn({ method: "validate", parameter: name, type: expectedType, value: value, status: STATUS_CODE.BadRequest });
        // If we do not know the expected type, be lenient and assume a string
        if (expectedType === "unknown") parameters[name] = chopQuotes(String(value));
        else throw new Deno.errors.InvalidData("Parameter '" + name + "' with value '" + value + "' is not of type '" + expectedType + "'");
      }
    }
  }

  return parameters;
}

let currentUserChecker = function (_request: Request): Promise<unknown> {
  return Promise.resolve(undefined);
};

export function setCurrentUserChecker<U>(cuc: (request: Request) => Promise<U | undefined>) {
  currentUserChecker = cuc;
}

/**
 * Load all controllers inside a directory and return a map of controller name to controller instance.
 *
 * @param path - Directory where to look for controllers
 * @param suffix - Suffix of the controller files. Everything before the suffix will be used as the controller name
 * @param classes - If false, returns map of controller name to instance. Otherwise, returns map of file name to controller class
 */
export function loadControllers(path: string, suffix?: string, classes?: false): Promise<Map<string, Controller>>;
export function loadControllers(path: string, suffix?: string, classes?: true): Promise<Map<string, { new (): Controller }>>;
export async function loadControllers(path: string, suffix = ".ts", classes?: boolean): Promise<Map<string, Controller | { new (): Controller }>> {
  const map = new Map<string, Controller | { new (): Controller }>();
  const base = new URL(path, import.meta.url);
  const files = Deno.readDirSync(base);
  for (const file of files) {
    if (!file.isFile || !file.name.endsWith(suffix)) continue;
    const url = new URL(base + "/" + file.name);

    // Load module
    const module = await import(url.toString());
    if (!module) throw new Error(`No module for controller file '${file.name}'`);

    // Build controller and add it to the map
    if (classes) map.set(file.name, module.default);
    else {
      const controller = (new module.default()) as Controller;
      const name = controller.base ?? file.name.substring(0, file.name.length - suffix.length);
      controller.url = url;
      map.set(name.startsWith("/") ? name : "/" + name, controller);
    }
  }
  return map;
}

// Will return a middleware that takes `ctx` as a single parameter
async function handleOne<T extends Controller>(controller: T, request: Request, base = controller.base, quiet = false) {
  let ct = contentType("json");

  // If there is no base, assign the kebab version of the controller name
  if (!base) base = "/" + kebabCase(controller.constructor.name);

  const logger = getLogger("grout");

  // Get a matching route
  const route = matchRoute(controller, request.method, request.url, base);

  // If there is no route, but there are routes for this controller, then it is a 405 / MethodNotAllowed
  if (!route && countRoutes(controller, request.url, base) > 0) {
    const status = STATUS_CODE.MethodNotAllowed;
    const message = "A route exists for this URL, but not for method '" + request.method + "'";
    logger.warn({ method: "handle", httpMethod: request.method, status, message });
    return new Response(JSON.stringify({ message }), { status, headers: { "content-type": ct } });
  }

  // If there is no route, then we should refuse to take care of this request, returning
  // 'undefined' which means that the next middleware will be called
  if (!route) return undefined;

  // Print debugging message of current route
  logger.debug({ method: "handle", httpMethod: request.method, route: route });

  const match = route.pattern.exec(request.url);
  const parameters: Record<string, unknown> = Object.assign({}, match?.search.groups, match?.pathname.groups);

  // Add query parameters
  const usp = new URL(request.url).searchParams;
  for (const [name, value] of usp) {
    if (name in parameters) continue;
    parameters[name] = value;
  }

  // Assign request
  parameters.$request = request;

  // Extract extension
  const pathname = new URL(request.url).pathname;
  const parts = pathname.split(".");
  const extension = parts.length > 1 ? parts.pop() : undefined;

  // Add special variables "body" if needed
  if (Object.hasOwn(route.schema.properties, "$body")) {
    const ct = request.headers.get("content-type") ?? "application/json";
    if (ct.startsWith("application/json")) parameters.$body = await request.json();
    else if (ct.startsWith("application/x-www-form-urlencoded")) parameters.$body = Object.fromEntries(await request.formData());
    else parameters.$body = await request.text();
  }

  // Now user if applicable
  if (Object.hasOwn(route.schema.properties, "$user")) {
    parameters.$user = await currentUserChecker(request);
  }

  try {
    // Check that is it needs a user it has one!
    if ("$user" in parameters && !parameters.$user) throw new Deno.errors.PermissionDenied();

    // Validate parameters
    validate(parameters, route.schema);

    // Call the handler
    const parameterNames = Object.keys(route.schema.properties);
    let body = await route.handler.apply(controller, parameterNames.map((name) => parameters[name]));
    if (body instanceof Response) return body;

    // Test if something is HTML
    const isHTML = RegExp.prototype.test.bind(/(<[-_.A-Za-z0-9]+).+>/i);

    // Assign content type depending on the extension and/or body
    if (extension) ct = contentType(extension) ?? extension;
    else if (typeof body === "string") ct = contentType(isHTML(body) ? "html" : "text");
    else if (body instanceof ArrayBuffer) ct = contentType("bin");
    else body = JSON.stringify(body);

    // Contruct response
    return new Response(body, { status: STATUS_CODE.OK, headers: { "content-type": ct } });
  } catch (ex) {
    if (!quiet && ex.message) console.warn("⚠️  [GROUT] " + ex.message);

    // Assign default status if we are here
    let status: number = STATUS_CODE.InternalServerError;
    if (ex instanceof Deno.errors.AlreadyExists) status = STATUS_CODE.Conflict;
    if (ex instanceof Deno.errors.InvalidData) status = STATUS_CODE.BadRequest;
    if (ex instanceof Deno.errors.NotFound) status = STATUS_CODE.NotFound;
    if (ex instanceof Deno.errors.NotSupported) status = STATUS_CODE.NotImplemented;
    if (ex instanceof Deno.errors.PermissionDenied) status = STATUS_CODE.Unauthorized;

    const log = { method: "handle", httpMethod: request.method, route: route, status, message: ex.message };
    if (status === STATUS_CODE.InternalServerError) {
      logger.error(log);
      console.error(ex);
    } else logger.warn(log);

    return new Response(JSON.stringify(ex), { status, headers: { "content-type": ct } });
  }
}

function handleMany(controllers: Map<string, Controller>, request: Request, globalPrefix = "", quiet = false): Promise<Response | undefined> {
  // Get the prefix to the request and handle appropriately
  const url = new URL(request.url);
  if (!url.pathname.startsWith(globalPrefix)) return Promise.resolve(undefined);

  // Iterate over all controllers
  const pn = url.pathname.substring(globalPrefix.length);
  const base = Array.from(controllers.keys()).find((b) => pn.startsWith(b));

  // If there is no base, we are done
  if (!base) return Promise.resolve(undefined);

  // Otherwise use 'handleOne' for the individual controller
  const controller = controllers.get(base);
  return handleOne(controller!, request, globalPrefix + base, quiet);
}

function handle(controllerOrControllers: Controller | Map<string, Controller>, request: Request, prefix = "", quiet = false): Promise<Response | undefined> {
  const many = controllerOrControllers instanceof Map;
  if (many) return handleMany(controllerOrControllers, request, prefix, quiet);
  else return handleOne(controllerOrControllers, request, prefix, quiet);
}

export { handle };
