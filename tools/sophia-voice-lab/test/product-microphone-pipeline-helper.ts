import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { expect } from "vitest";

/**
 * The deployed microphone pipeline, extracted from the frontend source for
 * the real-Chromium tests: the top-level declarations
 * startMicrophoneAudioPipeline reaches, plus those of relative modules it
 * imports (the product's StreamingPcm16Resampler, in revisions that have
 * one), in source order and only type-stripped. The product client, not a
 * reimplementation. Any other import fails here.
 */
export const PRODUCT_PIPELINE_SOURCE = path.resolve(process.cwd(), "../../frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts");

interface ModuleIndex { source: ts.SourceFile; declarations: Map<string, ts.Statement>; imports: Map<string, string> }
interface Extracted { label: string; text: string }

function declaredNames(statement: ts.Statement): string[] {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) return [statement.name.text];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
}

function importedNames(statement: ts.Statement): Array<[string, string]> {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  const specifier = statement.moduleSpecifier.text;
  return bindings.elements.map((element): [string, string] => [element.name.text, specifier]);
}

async function indexModule(file: string): Promise<ModuleIndex> {
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const declarations = new Map<string, ts.Statement>();
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    for (const name of declaredNames(statement)) declarations.set(name, statement);
    for (const [name, specifier] of importedNames(statement)) imports.set(name, specifier);
  }
  return { source, declarations, imports };
}

function identifiersIn(node: ts.Node, into = new Set<string>()): Set<string> {
  if (ts.isIdentifier(node)) into.add(node.text);
  ts.forEachChild(node, (child) => { identifiersIn(child, into); });
  return into;
}

/** The statements `roots` reach inside one module, and the names they need from relative modules it imports. */
function reach(index: ModuleIndex, roots: string[]): { included: Set<ts.Statement>; imported: Map<string, string[]> } {
  const included = new Set<ts.Statement>();
  const imported = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const statement = index.declarations.get(name);
    const specifier = index.imports.get(name);
    if (statement) {
      included.add(statement);
      queue.push(...[...identifiersIn(statement)].filter((identifier) => index.declarations.has(identifier) || index.imports.has(identifier)));
    } else if (specifier !== undefined) {
      if (!specifier.startsWith("./")) throw new Error(`The microphone pipeline imports ${name} from ${specifier}, which this test cannot inline.`);
      imported.set(specifier, [...(imported.get(specifier) ?? []), name]);
    }
  }
  return { included, imported };
}

async function moduleClosure(file: string, roots: string[]): Promise<Extracted[]> {
  const index = await indexModule(file);
  const { included, imported } = reach(index, roots);
  const dependencies: Extracted[] = [];
  for (const [specifier, names] of imported) dependencies.push(...await moduleClosure(path.resolve(path.dirname(file), `${specifier}.ts`), names));
  return [...dependencies, ...[...included].sort((a, b) => a.pos - b.pos).map((statement) => ({
    label: `${path.basename(file)}:${declaredNames(statement).join(",")}`,
    text: statement.getText(index.source).replace(/^export\s+/, ""),
  }))];
}

/** The page script exposing `window.__productPipeline.startMicrophoneAudioPipeline`, and the `module:name` labels of what it contains. */
export async function productPipeline(): Promise<{ script: string; declarations: string[] }> {
  const statements = await moduleClosure(PRODUCT_PIPELINE_SOURCE, ["startMicrophoneAudioPipeline"]);
  expect(statements.some((statement) => statement.text.startsWith("function startMicrophoneAudioPipeline"))).toBe(true);
  const js = ts.transpileModule(statements.map((statement) => statement.text).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return {
    script: `window.__productPipeline = (() => { ${js}\n return { startMicrophoneAudioPipeline }; })();`,
    declarations: statements.map((statement) => statement.label).sort(),
  };
}

export async function productPipelineScript(): Promise<string> {
  return (await productPipeline()).script;
}
