#!/usr/bin/env -S deno test -A

import { assertEquals } from "std/assert/mod.ts";
import { getParametersFromAST, getParametersFromSource } from "../src/reflection.ts";

const test = Deno.test;

test("Simple From Source", function fromSource() {
  const params = (fn: Function) => getParametersFromSource(fn)?.properties;

  // @ts-ignore deno-fmt-ignore Testing on pure Javascript
  assertEquals(params(function src1(a, b) {return a + b;}), { a: { type: "any" }, b: { type: "any" } });

  // deno-fmt-ignore Unfortunately with Typescript we CANNOT get the parameter types 😢
  assertEquals(params(function src2(a: number, b: number) {return a + b;}), { a: { type: "any" }, b: { type: "any" } });

  // Note that we can get parameters for arrow functions
  assertEquals(params(function src3() {/* Nothing */}), {});
  assertEquals(params(() => 0), {});

  // @ts-ignore Testing on pure Javascript
  assertEquals(params(function src4(_a, /* = 1 */ _b /* = true */) {}), { _a: { type: "any" }, _b: { type: "any" } });

  // Testing default values will guess correct type (note src6 has wrong type for boolean)
  assertEquals(params(function src5(_a = 1, _b = true) {}), { _a: { default: 1, type: "number" }, _b: { default: true, type: "boolean" } });
  assertEquals(params(function src6(_a = 1, _b?: boolean) {}), { _a: { default: 1, type: "number" }, _b: { type: "any" } });
  assertEquals(params((a = "foo") => a), { a: { default: "foo", type: "string" } });
  assertEquals(params(function src8(_a = 42) {}), { _a: { default: 42, type: "number" } });
});

test("Simple From AST", function fromAST() {
  const file = import.meta.filename!;
  const params = (fn: Function) => getParametersFromAST(file, fn)?.properties;

  // @ts-ignore deno-fmt-ignore Testing on pure Javascript
  assertEquals(params(function ast1(a, b) {return a + b;}), { a: { type: "any" }, b: { type: "any" } });

  // deno-fmt-ignore fortunately with Typescript we CAN get the parameter types 🎉
  assertEquals(params(function ast2(a: number, b: number) {return a + b;}), { a: { type: "number" }, b: { type: "number" } });

  // Note that we CANNOT get parameters for arrow functions
  assertEquals(params(function ast3() {/* Nothing */}), {});
  assertEquals(params(() => 0), undefined);

  // @ts-ignore Testing on pure Javascript
  assertEquals(params(function ast4(_a, /* = 1 */ _b /* = true */) {}), { _a: { type: "any" }, _b: { type: "any" } });

  // Testing default values will guess correct type (note we transform arrow function)
  assertEquals(params(function ast5(_a = 1, _b = true) {}), { _a: { default: 1, type: "number" }, _b: { default: true, type: "boolean" } });
  assertEquals(params(function ast6(_a = 1, _b?: boolean) {}), { _a: { default: 1, type: "number" }, _b: { default: undefined, type: "boolean" } });
  assertEquals(params(function ast7(a = "foo") { return a }), { a: { default: "foo", type: "string" } });
  assertEquals(params(function ast8(_a = 42) {}), { _a: { default: 42, type: "number" } });

  // Testing complex types
  assertEquals(params(function ast9(_ids: number[]) {}), { _ids: { type: "number[]" } });
  assertEquals(params(function ast10(_ids = []) {}), { _ids: { default: [], type: "any[]" } });
  assertEquals(params(function ast11(_ids = [1, 2, 3]) {}), { _ids: { default: [1, 2, 3], type: "number[]" } });
  assertEquals(params(function ast12(_ids = [1, "foo"]) {}), { _ids: { default: [1, "foo"], type: "(string | number)[]" } });
});