# 🪆 Grout

Inspired on [routing-controllers](https://github.com/typestack/routing-controllers) for use in Deno. Objective is to have a library that is as powerful as "routing-controllers", less verbose and with no decorator dependency. You can use grout with plain Deno handlers (and there is an adapter for [oak](https://github.com/oakserver/oak)).

## Motivation

I have happily used [routing-controllers](https://github.com/typestack/routing-controllers) for several projects. However at some point it started to feel verbose and that it had the following drawbacks/limitations:

- Too many decorators
- Goes against the [DRY](https://www.google.com/search?client=safari&rls=en&q=dry+principle&ie=UTF-8&oe=UTF-8) principle, as in `get(@Param("id") id: number)`
- Depends on metadata/reflection

I tried to craft a library as versatile as routing-controllers, that is less verbose and does not depend on decorators for metadata (instead using runtime type detection and convention over configuration).


## Installation

To use simple import the "https://deno.land/x/grout/mod.ts" url. Added bonus: no need to import "reflect-metatada" or create a "tsconfig.js".


## Example of usage

See file `users.controller.ts` below. It will be a somewhat functional (albeit naïve) in-memory database of users. Below is a very simplified version of the controller used in tests. The controller declares REST routes via the name of the method and path parameters start with `$` (as in `delete_$id`).

Methods are defined according to the following grammar (`_` transforms into `/`, `$parama` into `:param` and `$$ext` into `.ext`).

```
METHOD_path_:param_new[$$ext]
```

Example usage:

```typescript
// Define a type for users
type User = { id: number, name: string };

// This is the in-memory DB for users
const users: User[] = [
  { id: 0, name: "root" },
  { id: 1, name: "John" },
  { id: 2, name: "Jane" },
];

// Declare a controller
class UserController {

  // DELETE /users/:id
  delete_$id(id = -1) {
    const i = users.findIndex(u => u.id === id);
    if (i == -1) throw new Deno.errors.NotFound();
    users.splice(i, 1);
    return { id, status: "deleted" };
  }

  // GET /users
  get() {
    return users;
  }

  // GET /users/:id
  get_$id(id = -1) {
    const user = users.find(u => u.id === id);
    if (!user) throw new Deno.errors.NotFound();
    return user;
  }

  // PUT /users/:id
  put_$id(id = 1, body: User) {
    const user = users.find(u => u.id === id);
    if (!user) throw new Deno.errors.NotFound();
    Object.assign(user, body);
    return { id, status: "created" };
  }
}
```

A simple sever can be created as `app.ts`:

```typescript
// Create a controller instance and route traffic to it, it will
// return a Response object if it was intended for it
const users = new UserController();
Deno.serve({ port: 8000 }, (request: Request) => {
  const response = handle(users, "/users", request);
  if (response) return response;
  // The router did not take the request, respond "Not Implemented"
  return new Response("NOT IMPLEMENTED", { status: Status.NotImplemented });
});

console.log("Server is running on port 8000. Open http://localhost:8000/users/");
```

You can now open the browser at `http://localhost:8000/users`. You will see a JSON document similar to:

```json
[{"id":0,"name":"root"},{"id":1,"name":"John"},{"id":2,"name":"Jane"}]
````

If you open `http://localhost:8000/users/1` you will see:

```json
{"id":1,"name":"John"}
````

You can play around with the user ID to see different users or try a non-existent user to see what happens.


## More examples

Examples here follow closely the documentation from "routing-controllers" as to validate parity of funcionality.

### Working with json/html/pdf/etc

Grout assumes that the controller will return JSON. However depending on the return type the content type is assumed. If the controller method already returns a `Response` then the response is just passed along. If the controller method path has an extension, it is used to determine the content type.

| Return Type    | Content Type                                                 |
| -------------- | ------------------------------------------------------------ |
| `String`       | text/html                                                    |
| `ArrayBuffer`  | application/octet-stream                                     |
| `Response`     | (embedded in response)                                       |
| `.<extension>` | Value of `contentType("<extension>")` (for example extension ".pdf") |
| All Others ... | application/json                                             |

Below are examples of `png` and `pgp` content types (with extension and raw). Full runnable examples in tests.

```typescript
class UserController {
	
  // Other routes ...
  
	// GET /users/:id/avatar.png
  get_$id_avatar$$png(id = -1) {
    if (!users.find(u => u.id === id)) throw new Deno.errors.NotFound();
    const png = "iVBORw0KG ... rkJggg==";
    return atob(png);
  }

  // GET /users/pgp
  get_pgp() {
    // See https://www.ietf.org/rfc/rfc3156.txt
    const pgp = `-----BEGIN PGP MESSAGE----- ... -----END PGP MESSAGE-----`;
    return new Response(pgp, { headers: { "Content-Type": "application/pgp-encrypted" } });
  }
}
```

### Returning promises

You can return either promises or direct values. The controller will wait and send the right response value.

### Using Request and Response objects

You can use framework's `request` by adding a parameter with that name to the method (which will inject a Web API [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request)). If you want to handle the response by yourself, you need to return the created a [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) object.

```typescript
export class DocumentController {
  // GET /document/:id/license
  getLicense(request: Request) {
    if (id === 42) return "Universal License";
    else return "MIT License";
  }
    
  // GET /document/:id/polict
  getPolicy($request: Request, $response: Response) {
  	// Redirects all document policies to wikipedia website's policy
    return Response.redirect("https://meta.wikimedia.org/wiki/Privacy_policy");
  }
}
```

The `Request` and `Response` types are directly accessible in Deno's global namespace.

### Load all controllers from the given directory

Use method `loadControllers` which returns a map of controllers.

## Comparison with Routing Controllers

> 🚧 Work in progress

| Feature                           | Routing Controllers        | Grout                                          |
| --------------------------------- | -------------------------- | ---------------------------------------------- |
| Load All Controllers              | ✅  `createExpressServer`   | ✅ `loadControllers`                            |
| Prefix All Controllers            | ✅  `createExpressServer`   | ⚠️ Left to server (or oak)                      |
| Prefix controller with base route | ✅  `@Controller`           | ✅  `base` argument                             |
| Inject routing/query parameters   | ✅  `@Param`                | ✅  Named function parameter                    |
| Typed Parameters                  | ✅  `isRArray` and `type`   | ✅  Use defaults                                |
| Inject request body               | ✅  `i@Body`                | ✅  Named `body` parameter                      |
| Inject request body parameters    | ✅  `@BodyParam`            | ⚠️ Not directly, use `body.param`               |
| Inject request header parameters  | ✅  `@HeaderParam`          | ⚠️ Not directly, use `headers.param`            |
| Inject cookie parameters          | ✅ `@CookieParam`           | ⚠️ Not directly, use `cookies.param`            |
| Inject session object             | ✅ `@SessionParam`          | ✅  Named `session` parameter                   |
| Inject state object               | ✅ `@State`                 | ❌ Niche, not supported                         |
| Inject uploaded file              | ✅ `@UploadedFile`          | ✅  Named `file(s)` parameter                   |
| Make parameter required           | ✅  `required`              | ✅ Parameter with default                       |
| Convert parameters to objects     | ⚠️ Via "class-transformers" | ⚠️ Not directly, use `new` on `body`            |
| Set custom ContentType            | ✅ `@ContentType`           | ⚠️ Not directly,  via extensions and `Response` |
| Set Location/Redirect/Code        | ✅ `@Location`              | ⚠️ Not directly,  via `Response`                |
| Render templates                  | ✅ `@Render`                | ❌ Specialized, left to server                  |
| Throw HTTP errors                 | ✅  Via exceptions          | ✅  Via exceptions                              |
| Middlewares                       | ✅ `@UseBefore/@UseAfter`   | ❌ Specialized, left to server                  |
| Interceptors                      | ✅ Via `@UseInterceptor`    | ⚠️ Not yet, in the works                        |
| Auto validating action params     | ✅ Via `validation`         | ❌ Specialized, left to validation library      |
| Authorization                     | ✅ Via `@Authorized`        | ❌ Specialized, support of `user`/`session`     |
|                                   |                            |                                                |

## Todo

- [ ] Implement interceptors
- [ ] Provide examples of session, user, headers parameters

## Miscellaneous

To make sure that Github can Codecov can talk, you need to set the `CODECOV_TOKEN` environment variable in the Github repository settings:

```bash
gh secret set CODECOV_TOKEN --body "$CODECOV_TOKEN"
```
