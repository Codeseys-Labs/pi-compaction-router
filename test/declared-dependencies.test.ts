/**
 * EVERY HOST PACKAGE THIS CODE IMPORTS IS DECLARED, AND DECLARED AS A PEER.
 *
 * Twice now this package has imported an `@earendil-works/*` module that `package.json` never named,
 * and twice the suite stayed green -- because bun hoists the host's own transitive dependencies to
 * the top-level `node_modules`, so `@earendil-works/pi-ai` and `@earendil-works/pi-tui` resolve for
 * us whether we ask for them or not. Pass-1 W4 found `pi-tui` that way; pass-2 W4 found `pi-ai`
 * (`src/index.ts` imports `Type` as a RUNTIME value for the recall tool schema). Hoisting is not a
 * contract: it depends on what the host happens to depend on and on what the resolver happens to do
 * with it, and neither is ours. An undeclared import is a package that installs and then fails to
 * resolve on someone else's tree.
 *
 * `bun install --frozen-lockfile` does NOT catch this: the specifier is already in the lockfile's
 * `packages` map as somebody else's transitive dependency, so nothing is missing and nothing is
 * added. That is precisely why this leaf exists rather than a lockfile check alone.
 *
 * The three assertions, and why each is separate:
 *
 *  1. Every `@earendil-works/*` specifier reached from `src/`, `test/` and `scripts/` is DECLARED.
 *     Specifiers come from the TypeScript AST, not a regex, so a package named in a comment or a
 *     doc string does not count and a real `import()` inside a function body does. Subpath imports
 *     (`@earendil-works/pi-ai/compat`) charge their package root, which is what gets installed.
 *
 *  2. Each one is declared in BOTH `peerDependencies` and `devDependencies`, and in NEITHER
 *     `dependencies` nor `optionalDependencies`. The host ships these packages; taking one as a
 *     runtime dependency would install a second copy of pi inside a pi extension. That is the
 *     zero-runtime-deps guardrail from `base-choice-verdict.md` §5 risk 4, asserted rather than
 *     remembered. `devDependencies` is what makes `tsc` and `bun test` resolve them here.
 *
 *  3. The lockfile's own workspace block agrees with `package.json`. `bun.lock` records the
 *     manifest's dependency blocks alongside the resolutions, and a plain `bun install` rewrites
 *     them -- but `--frozen-lockfile` passes happily while they are stale, which is how the
 *     lockfile went a whole wave describing a `pi-tui`-less manifest. Stale metadata there is a
 *     lockfile that no longer describes the package it locks.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
/** `scripts/` is outside `tsconfig.json`'s `include`, so nothing else would notice an import there. */
const SCANNED_DIRS = ["src", "test", "scripts"] as const;
const HOST_SCOPE = "@earendil-works/";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;

function typeScriptFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((rel) => extname(rel) === ".ts");
}

/**
 * Every module specifier the TypeScript parser can see: static `import`/`export ... from`, dynamic
 * `import()`, `import("x").T` type positions, and `mock.module("x", ...)` -- which is a real module
 * resolution the compiler does not treat as one, and which several tests in this suite use.
 */
function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const walk = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) literal(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isMockModule = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "module";
      if (isDynamicImport || isMockModule) literal(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/** `@earendil-works/pi-ai/compat` installs as `@earendil-works/pi-ai`. Charge the root. */
function packageRoot(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

const importsByPackage = new Map<string, string[]>();
for (const dir of SCANNED_DIRS) {
  for (const file of typeScriptFiles(dir)) {
    for (const specifier of moduleSpecifiers(file)) {
      if (!specifier.startsWith(HOST_SCOPE)) continue;
      const root = packageRoot(specifier);
      const sites = importsByPackage.get(root) ?? [];
      if (!sites.includes(file)) sites.push(file);
      importsByPackage.set(root, sites);
    }
  }
}
const imported = [...importsByPackage.keys()].sort();

describe("declared dependencies", () => {
  test("the scan actually found the host packages this code is built on", () => {
    // A scanner that silently matched nothing would make every assertion below vacuous. These three
    // are load-bearing today: pi-coding-agent is the host API, pi-tui the settings dialog, pi-ai the
    // recall tool's `Type` schema plus the retry and usage types.
    expect(imported).toContain("@earendil-works/pi-coding-agent");
    expect(imported).toContain("@earendil-works/pi-tui");
    expect(imported).toContain("@earendil-works/pi-ai");
    expect(importsByPackage.get("@earendil-works/pi-ai")).toContain("src/index.ts");
  });

  test("every imported host package is declared in package.json", () => {
    const undeclared = imported.filter((name) => !(name in (manifest.peerDependencies ?? {})) || !(name in (manifest.devDependencies ?? {})));
    // The message carries the import sites, because "undeclared" is useless without "imported where".
    expect(undeclared.map((name) => `${name} (imported by ${importsByPackage.get(name)?.join(", ")})`)).toEqual([]);
  });

  test("host packages are peers, never installed runtime dependencies", () => {
    // The host ships these. A `dependencies` entry would install a second pi inside a pi extension.
    for (const block of ["dependencies", "optionalDependencies"] as const) {
      expect(Object.keys(manifest[block] ?? {}).filter((name) => name.startsWith(HOST_SCOPE))).toEqual([]);
    }
    for (const name of imported) {
      expect(manifest.peerDependencies?.[name]).toStartWith(">=");
      expect(manifest.devDependencies?.[name]).toStartWith("^");
    }
  });

  test("nothing is declared that nothing imports", () => {
    // The other direction: a peer we stopped importing is a constraint we are imposing on hosts for
    // no reason. `pi-agent-core` is deliberately not here -- it is the host's own transitive dep.
    const declared = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith(HOST_SCOPE));
    expect(declared.sort()).toEqual(imported);
  });

  test("the lockfile's workspace block matches package.json", () => {
    // `bun.lock` is JSONC (trailing commas), and `--frozen-lockfile` passes while this drifts.
    const lock = JSON.parse(readFileSync(join(ROOT, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1")) as {
      workspaces: Record<string, Manifest>;
    };
    const workspace = lock.workspaces[""];
    expect(workspace).toBeDefined();
    for (const block of ["peerDependencies", "devDependencies", "dependencies", "optionalDependencies"] as const) {
      expect(workspace?.[block] ?? {}).toEqual(manifest[block] ?? {});
    }
  });
});
