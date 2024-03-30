import { FunctionDeclaration, FunctionExpression, MethodDeclaration, Project } from "ts_morph/mod.ts";
import { Property, Schema } from "./grout.ts";

// Simple types for JSON schema
// See https://json-schema.org/learn/getting-started-step-by-step#define

// const cache = new Map<string, Schema>();

// Using balanced parenthesis
export function getParametersFromSource(fn: Function): Schema | undefined {
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
  const tokens = source.substring(s, e).split(",");
  const properties: Record<string, Property> = {};
  const schema = { $id: fn.name, type: "object", properties, required: [] } as Schema;

  // Extract defaults
  for (const token of tokens) {
    const p = token.indexOf("=");
    const potentialValue = token.substring(p + 1).trim();
    const name = p === -1 ? token.trim() : token.substring(0, p).trim();
    const value = p === -1 || potentialValue === "undefined" ? undefined : JSON.parse(potentialValue);
    if (!name) continue;
    const type = typeof(value);
    const property = { type: type === "undefined" ? "any" : type } as Property;
    if (p !== -1) property["default"] = value;
    if (p === -1) schema.required.push(name);
    properties[name] = property;
  }

  return schema;
}

const project = new Project({ useInMemoryFileSystem: true });

export function getParametersFromAST(file: string, fn: Function): Schema | undefined {
  let sourceFile = project.getSourceFile(file);
  if (!sourceFile) {
    const contents = Deno.readTextFileSync(file);
    sourceFile = project.createSourceFile(file, contents);
  }

  // Find function expression
  // const fe = sourceFile.getFunction(fn.name)!;
  let functionNode: FunctionDeclaration | FunctionExpression | MethodDeclaration | undefined;
  sourceFile.forEachDescendant(node => {
    if (functionNode) return;
    if (!(node instanceof FunctionDeclaration || node instanceof FunctionExpression || node instanceof MethodDeclaration)) return;
    if (node.getName() === fn.name) functionNode = node;
  });
  if (!functionNode) return undefined;

  // Construct a schema
  const parameters = functionNode.getParameters();
  const properties: Record<string, Property> = {};
  const schema = { $id: fn.name, type: "object", properties, required: [] } as Schema;
  for (const p of parameters) {
    const property: Property = { type: p.getType().getText() ?? "any" };
    if (p.hasInitializer()) property.default = JSON.parse(p.getInitializer()!.getText());
    else if (p.isOptional()) property.default = undefined;
    properties[p.getName()] = property;
  }

  return schema;
}
