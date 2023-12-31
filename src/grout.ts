import { getLogger } from "std/log/mod.ts";
import { isHttpMethod, Status } from "std/http/mod.ts";
import { contentType } from "std/media_types/mod.ts";

// Special variables are $body, $request, $session, $user

export type Controller = {
  /**
   * Indicates the base path for all routes in this controller
   */
  base?: string;

  /**
   * Indicates if the controller is open (i.e. no authentication required)
   */
  open?: boolean;
};

// deno-lint-ignore ban-types
type Handler = Function;

/**
 * Route embedded in class method
 */
type Route = {
  pathname: string;
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
    if (!isHttpMethod(method)) continue;

    const pathname = base + (parts.length ? "/" : "") + parts.join("/");
    const pattern = new URLPattern({ pathname });
    const parameters = getParameters(handler);
    routes.push({ pathname, method, pattern, handler, parameters });
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

function validate(requestParameters: Record<string, unknown>, functionParameters: Record<string, unknown>): Record<string, unknown> {
  // Will store the final parameters
  const parameters = Object.assign({}, functionParameters);

  const logger = getLogger("grout");

  // Check that all parameters are defined
  for (const fpn of Object.keys(functionParameters)) {
    const fpv = functionParameters[fpn];
    const rpv = requestParameters[fpn] || requestParameters[kebabCase(fpn)];

    // Check if the parameter is required
    if (fpv === undefined && rpv === undefined) {
      logger.warning({ method: "validate", parameter: fpn, condition: "REQUIRED" });
      throw new Deno.errors.InvalidData("Parameter '" + fpn + "' is required");
    }

    const isDefined = rpv !== undefined;

    // Simple case
    parameters[fpn] = rpv;

    // Check if it is correctly a boolean
    if (typeof fpv === "boolean" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'boolean'";
      if (rpv !== "true" && rpv !== "false") {
        logger.warning({ method: "validate", parameter: fpn, type: "boolean", value: rpv, status: Status.BadRequest });
        throw new Deno.errors.InvalidData(message);
      }
      parameters[fpn] = rpv === "true";
    }

    // Check if it is correctly a number
    if (typeof fpv === "number" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'number'";
      const n = parseInt(String(rpv));
      if (Number.isNaN(n)) {
        logger.warning({ method: "validate", parameter: fpn, type: "number", value: rpv, status: Status.BadRequest });
        throw new Deno.errors.InvalidData(message);
      }
      parameters[fpn] = n;
    }

    // Check if it is correctly an object
    if (typeof fpv === "object" && isDefined) {
      const message = "Parameter '" + fpn + "' with value '" + rpv + "' is not of type 'object'";
      try {
        parameters[fpn] = JSON.parse(String(rpv));
      } catch (_ex) {
        logger.warning({ method: "validate", parameter: fpn, type: "object", value: rpv, status: Status.BadRequest });
        throw new Deno.errors.InvalidData(message);
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
    const status = Status.MethodNotAllowed;
    const message = "A route exists for this URL, but not for method '" + request.method + "'";
    logger.warning({ method: "handle", httpMethod: request.method, status, message });
    return new Response(JSON.stringify({ message }), { status, headers: { "content-type": ct } });
  }

  // If there is no route, then we should refuse to take care of this request, returning
  // 'undefined' which means that the next middleware will be called
  if (!route) return undefined;

  // Print debugging message of current route
  logger.debug({ method: "handle", httpMethod: request.method, route: route });

  const match = route.pattern.exec(request.url);
  const functionParameters: Record<string, unknown> = route.parameters;
  const requestParameters: Record<string, unknown> = Object.assign({}, match?.search.groups, match?.pathname.groups);

  // Add query parameters
  const usp = new URL(request.url).searchParams;
  for (const [name, value] of usp) {
    if (name in requestParameters) continue;
    requestParameters[name] = value;
  }

  // Assign request
  requestParameters.$request = request;

  // Extract extension
  const pathname = new URL(request.url).pathname;
  const parts = pathname.split(".");
  const extension = parts.length > 1 ? parts.pop() : undefined;

  // Add special variables "body" if needed
  if (Object.hasOwn(functionParameters, "$body")) {
    const ct = request.headers.get("content-type") ?? "application/json";
    if (ct.startsWith("application/json")) requestParameters.$body = await request.json();
    else if (ct.startsWith("application/x-www-form-urlencoded")) requestParameters.$body = Object.fromEntries(await request.formData());
    else requestParameters.$body = await request.text();
  }

  // Now user if applicable
  if (Object.hasOwn(functionParameters, "$user")) {
    requestParameters.$user = await currentUserChecker(request);
  }

  try {
    // Check that is it needs a user it has one!
    if ("$user" in requestParameters && !requestParameters.$user) throw new Deno.errors.PermissionDenied();

    // Validate parameters
    const parameters = validate(requestParameters, functionParameters!);

    // Call the handler
    let body = await route.handler.apply(controller, Object.values(parameters));
    if (body instanceof Response) return body;

    // Test if something is HTML
    const isHTML = RegExp.prototype.test.bind(/(<[-_.A-Za-z0-9]+).+>/i);

    // Assign content type depending on the extension and/or body
    if (extension) ct = contentType(extension) ?? extension;
    else if (typeof body === "string") ct = contentType(isHTML(body) ? "html" : "text");
    else if (body instanceof ArrayBuffer) ct = contentType("bin");
    else body = JSON.stringify(body);

    // Contruct response
    return new Response(body, { status: Status.OK, headers: { "content-type": ct } });
  } catch (ex) {
    if (!quiet && ex.message) console.warn("⚠️  [GROUT] " + ex.message);

    // Assign default status if we are here
    let status = Status.InternalServerError;
    if (ex instanceof Deno.errors.AlreadyExists) status = Status.Conflict;
    if (ex instanceof Deno.errors.InvalidData) status = Status.BadRequest;
    if (ex instanceof Deno.errors.NotFound) status = Status.NotFound;
    if (ex instanceof Deno.errors.NotSupported) status = Status.NotImplemented;
    if (ex instanceof Deno.errors.PermissionDenied) status = Status.Unauthorized;

    const log = { method: "handle", httpMethod: request.method, route: route, status, message: ex.message };
    if (status === Status.InternalServerError) {
      logger.error(log);
      console.error(ex);
    } else logger.warning(log);

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
  return handleOne(controller!, request, globalPrefix + base);
}

export function handle(controllerOrControllers: Controller | Map<string, Controller>, request: Request, prefix = "", quiet = false): Promise<Response | undefined> {
  const many = controllerOrControllers instanceof Map;
  if (many) return handleMany(controllerOrControllers, request, prefix, quiet);
  else return handleOne(controllerOrControllers, request, prefix, quiet);
}
