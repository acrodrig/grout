#!/usr/bin/env -S deno test -A

// Corresponds to https://github.com/typestack/routing-controllers/blob/develop/test/functional/json-controller-methods.spec.ts

import { Status } from "std/http/mod.ts";
import { assertEquals, assertExists } from "std/assert/mod.ts";
import { Controller, handle, loadControllers, setCurrentUserChecker } from "../src/grout.ts";
import { Fetcher } from "./helpers.ts";
import UsersController from "./users.controller.ts";

const test = Deno.test;

const PORT = 8378;

const controller = new UsersController() as Controller;

// Set user checker function
setCurrentUserChecker<string>((request: Request) => {
  const user = request.headers.get("x-user") ?? undefined;
  return Promise.resolve(user);
});

Deno.serve({ port: PORT }, async (request: Request) => {
  const response = await handle(controller, request, "/users");
  return response ?? new Response("NOT IMPLEMENTED", { status: Status.NotImplemented });
});

const fetcher = new Fetcher("http://localhost:" + PORT);

// Listing all (non-admin) users via GET /users
test("list", async () => {
  const { status, headers, data } = await fetcher.go("GET", "/users");
  assertEquals(status, Status.OK);
  assertEquals(headers.get("content-type"), "application/json; charset=UTF-8");
  assertEquals(data, [{ id: 1, name: "John" }, { id: 2, name: "Jane" }, { id: 3, name: "Patrick" }]);
});

test("list sorted", async () => {
  const { status, data } = await fetcher.go("GET", "/users?sort=true");
  assertEquals(status, Status.OK);
  assertEquals(data, [{ id: 2, name: "Jane" }, { id: 1, name: "John" }, { id: 3, name: "Patrick" }]);

  // Make sure that 'false' also works!
  const response = await fetcher.go("GET", "/users?sort=false");
  assertEquals(response.data, [{ id: 1, name: "John" }, { id: 2, name: "Jane" }, { id: 3, name: "Patrick" }]);
});

// Listing all users via GET /users
// NOTE: This is also testing specificy of routes (i.e. /users/admins is more specific than /users:id)
test("admins", async () => {
  // First with no user
  const { status } = await fetcher.go("GET", "/users/admins", undefined, true);
  assertEquals(status, Status.Unauthorized);

  // Now with admin user
  const { data } = await fetcher.go("GET", "/users/admins", undefined, true, { "x-user": "root" });
  assertEquals(data, [{ id: 0, name: "root", admin: true }]);
});

// Cannot apply method DELETE to the list of users
test("list 405", async () => {
  const { status } = await fetcher.go("DELETE", "/users", undefined, true);
  assertEquals(status, Status.MethodNotAllowed);
});

// Gets a single users
test("get", async () => {
  const { status, data } = await fetcher.go("GET", "/users/1");
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 1, name: "John" });
});

// Gets a non-existant user with id 42, which returns a 404
test("get 404", async () => {
  const { status, data } = await fetcher.go("GET", "/users/42", undefined, true);
  assertEquals(status, Status.NotFound);
  assertEquals((data as Error).name, "NotFound");
});

// Deletes user with id 1 (John)
test("delete", async () => {
  const { status, data } = await fetcher.go("DELETE", "/users/1");
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 1, status: "deleted" });
});

// Tries to delete user with id 1 (John) again, which returns a 404
test("delete 404", async () => {
  const { status, headers, data } = await fetcher.go("DELETE", "/users/1", undefined, true);
  assertEquals(status, Status.NotFound);
  assertEquals(headers.get("content-type"), "application/json; charset=UTF-8");
  assertEquals((data as Error).name, "NotFound");
});

// Getting a head on the list of users is allowed and has no body
test("head", async () => {
  const { status, data } = await fetcher.go("HEAD", "/users");
  assertEquals(status, Status.OK);
  assertEquals(data, "");
});

// Patching user with id 2 (Jane)
test("patch", async () => {
  const { status, data } = await fetcher.go("PATCH", "/users/2", { name: "Janet", comment: "Forgot the T" });
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 2, status: "patched" });
});

// Creating a new user (Peter) with POST
test("post", async () => {
  const { status, data } = await fetcher.go("POST", "/users", { name: "Peter" });
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 4, status: "posted" });
});

// Updating user with id 3 (Patrick) with PUT
test("put", async () => {
  const { status, data } = await fetcher.go("PUT", "/users/3", { id: 3, name: "Pat", comment: "Nickname is better" });
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 3, status: "put" });
});

// Tries non-existant user 123 on a "promised" method and get a 404
test("getPromiseFail", async () => {
  const { status, data } = await fetcher.go("GET", "/users/123/async", undefined, true);
  assertEquals(status, Status.NotFound);
  assertEquals((data as Error).name, "NotFound");
});

// Tries existing user 0 on a "promised" method and get a 200
test("getPromiseOk", async () => {
  const { status, data } = await fetcher.go("GET", "/users/0/async");
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 0, name: "root", admin: true });
});

// Tries non-existing controller method /balls/123 and get a 501
test("nonExistant", async () => {
  const { status } = await fetcher.go("GET", "/balls/123");
  assertEquals(status, Status.NotImplemented);
});

// Gets an image via an extension controller method (see method 'get_$id_avatar$$png' in file 'users.controller.ts')
test("image", async () => {
  const { status, headers } = await fetcher.go("GET", "/users/0/avatar.png");
  assertEquals(status, Status.OK);
  assertEquals(headers.get("content-type"), "image/png");
});

// Get a custom response via a method that returns a response directly
test("custom", async () => {
  const { status, headers } = await fetcher.go("GET", "/users/pgp");
  assertEquals(status, Status.OK);
  assertEquals(headers.get("content-type"), "application/pgp-encrypted");
});

// Get a redirected response
test("redirect", async () => {
  const { status, redirected, headers } = await fetcher.go("GET", "/users/policy");
  assertEquals(status, Status.OK);
  assertEquals(redirected, true);
  assertEquals(headers.get("content-type"), "text/html; charset=UTF-8");
});

// Tries to call an EXISTING method in the controller that does not map to an HTTP method
test("invalid", async () => {
  const { status } = await fetcher.go("GET", "/find?{ name: 'Peter' }");
  assertEquals(status, Status.NotImplemented);
});

// Gets multiple users via GET /users/multiple
test.ignore("get multiple", async () => {
  const { status, data } = await fetcher.go("GET", "/users/multiple?ids=abc");
  assertEquals(status, Status.OK);
  assertEquals(data, [{ id: 2, name: "Janet" }, { id: 3, name: "Pat" }]);
});

// Gets multiple users via GET /users/multiple
test("load", async () => {
  const dir = new URL(".", import.meta.url);
  const controllers = await loadControllers(dir.toString(), ".controller.ts");
  assertEquals(controllers.size, 1);
  assertExists(controllers.get("/users"));
  const classes = await loadControllers(dir.toString(), ".controller.ts", true);
  assertEquals(classes.size, 1);
  assertExists(classes.get("users.controller.ts"));
});

// Creating a new user (Mark) with POST and "application/x-www-form-urlencoded"
test("post", async () => {
  const headers = { "content-Type": "application/x-www-form-urlencoded" };
  const { status, data } = await fetcher.go("POST", "/users", new URLSearchParams({ name: "Mark", admin: "false" }), false, headers);
  assertEquals(status, Status.OK);
  assertEquals(data, { id: 5, status: "posted" });

  // Make sure the user was created with the right values
  assertEquals((await fetcher.go("GET", "/users/5")).data, { id: 5, name: "Mark", admin: "false" });
});
