import { getLogger } from "std/log/mod.ts";
import { isHttpMethod, Status } from "std/http/mod.ts";
import { contentType } from "std/media_types/mod.ts";

const logger = getLogger("grout:grout");

// Special variables are $body, $request, $session, $user

export type Controller = {
  /**
   * Indicates the base path for all routes in this controller
   */
  base: string;

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

  // More specific routes (with less parameters) should be first, longer routes should be first
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

export async function loadControllers(path: string, suffix = ".ts"): Promise<Map<string, { new (): Controller }>> {
  const map = new Map<string, { new (): Controller }>();
  const base = new URL(path, import.meta.url);
  const files = Deno.readDirSync(base);
  for (const file of files) {
    if (!file.isFile || !file.name.endsWith(suffix)) continue;
    const url = new URL(base + "/" + file.name);
    const module = await import(url.toString());
    map.set(file.name, module.default);
    if (!module) throw new Error(`No module for controller file '${file.name}'`);
  }
  return map;
}

// Will return a middleware that takes `ctx` as a single parameter
export async function handle<T extends Controller>(controller: T, request: Request, base = controller.base, quiet = false) {
  let ct = contentType("json");

  // If there is no base, assign the kebab version of the controller name
  if (!base) base = "/" + kebabCase(controller.constructor.name);

  // Get a matching route
  const route = matchRoute(controller, request.method, request.url, base);
  if (!route && countRoutes(controller, request.url, base)) {
    const status = Status.MethodNotAllowed;
    const error = "A route exists for this URL, but not for method '" + request.method + "'";
    logger.warning({ method: "handle", httpMethod: request.method, route: route, status });
    return new Response(JSON.stringify({ message: error }), { status, headers: { "content-type": ct } });
  }
  if (!route) return undefined;

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
  const parts = request.url.split(".");
  const extension = parts.length > 1 ? parts.pop() : undefined;

  // Add special variables "body" if needed
  if (Object.hasOwn(functionParameters, "$body")) {
    requestParameters.$body = await request.json();
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

    // Assign content type depending on the extension and/or body
    if (extension) ct = contentType(extension) ?? extension;
    else if (typeof body === "string") ct = contentType("html");
    else if (body instanceof ArrayBuffer) ct = contentType("bin");
    else body = JSON.stringify(body);

    // Contruct response
    return new Response(body, { status: Status.OK, headers: { "content-type": ct } });
  } catch (ex) {
    if (!quiet && ex.message) console.warn("⚠️  [GROUT] "+ex.message);

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
    }
    else logger.warning(log);

    return new Response(JSON.stringify(ex), { status, headers: { "content-type": ct } });
  }
}
