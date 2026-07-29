/**
 * Orphan-suite gate.
 *
 * A test file that no stage executes is not coverage; it is decoration that reads like coverage.
 * This class of defect has already been found twice in sibling repositories of this bundle: a gate
 * whose stage list simply never mentioned `tests/integration/`, and a fork carrying `test/`
 * (singular) while its only glob was `tests/**` (plural) -- three files, eighteen assertions, two of
 * them importing a package that was never a dependency, so they exited ERR_MODULE_NOT_FOUND and had
 * never executed once. Nothing about either repo looked wrong; both gates were green.
 *
 * `bun test` scans recursively, which removes the plural/singular trap but NOT the class. What this
 * checker asserts is exactly what the runner was MEASURED to miss -- nothing more, because a guard
 * that duplicates the runner is a guard nobody can prove is doing anything:
 *
 *   1. bun's discovery is NAME-based and narrower than it looks. In a directory holding a.test.ts,
 *      b.spec.ts, c_test.ts, e_spec.ts, d-test.ts, f-spec.ts and test-g.ts, each with a deliberately
 *      failing assertion, `bun test` reported `Ran 4 tests across 4 files.` -- `d-test.ts`,
 *      `f-spec.ts` and `test-g.ts` were never run and never mentioned. Confirmed against this
 *      repository: planting `src/planted-test.ts` (importing bun:test) left `bun test` reporting
 *      `Ran 26 tests across 3 files.` at exit 0, blind to it.
 *
 *   2. `--path-ignore-patterns` excludes silently. A file excluded from the scanning stage and named
 *      by no other stage is never executed, and the runner reports success.
 *
 *   3. A stage can exist, be correct, and simply never be invoked by `check`. That was the original
 *      bite in a sibling repo, whose gate never mentioned `tests/integration/` at all. Reachability
 *      from `check` is therefore resolved transitively here rather than assumed.
 *
 *   4. An UNREADABLE directory is skipped in silence. MEASURED: with a failing suite inside a
 *      `chmod 000` directory, `bun test` exited 0 and never mentioned it.
 *
 * DELETED after measuring rather than kept "just in case" -- each was a guard for a hole that does
 * not exist, and an unfalsifiable guard is worse than none:
 *   - a missing explicit path. `bun test test/missing.test.ts` (file absent) exits 1.
 *   - an empty suite set. `bun test` in a tree with no suite files exits 1, as does `bun test <dir>`
 *     when the directory holds none.
 *   An earlier draft of this file asserted BOTH of those exit 0. That reading came from
 *   `bun test ... | tail -6; echo $?`, which reports the exit status of `tail`. Measure the command,
 *   not the pipeline.
 *
 * Symlinked directories are FOLLOWED here, deduplicated by realpath so a cycle terminates. Not a
 * style choice: `bun test` was MEASURED to follow them (a suite behind `test/linked -> ../real` ran,
 * `Ran 2 tests across 3 files.`), so a walker that refused them would produce a FALSE refusal, and a
 * walker that skipped them would let a hyphen-named suite hide behind one. The walker matches the
 * runner. (The sibling checker in pi-dynamic-fractal-workflows reports them instead, because node's
 * `--test` glob was measured NOT to follow them -- a suite behind a symlink there really is dead.)
 *
 * Usage: `bun scripts/check-suite-coverage.ts [repoRoot]`
 *   The optional argument points the checker at a synthetic fixture tree, which is how its own suite
 *   exercises each refusal without planting files in this repository.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * The stages that run suites. DECLARED, not inferred: the whole point is that the filesystem is
 * compared against a stated intention, so that adding a suite nothing runs breaks the build instead
 * of quietly enlarging the set of files nobody executes.
 */
const DECLARED_SUITE_STAGES = ["test"];

/** The script every agent runs, and the root of the reachability check. */
const GATE_SCRIPT = "check";

/**
 * Directories that cannot hold a suite this repository owns: dependencies, build output, VCS
 * metadata and OTHER checkouts. No source directory is listed. Excluding a source directory is how a
 * sibling repo hid a failing suite from its own inventory for weeks.
 */
const SUITE_SEARCH_EXCLUDES = ["node_modules", ".worktrees", ".git", "dist", "build", "coverage"];

/**
 * bun's MEASURED discovery patterns (see hole 1 in the header). A file matching one of these is
 * executed by a bare `bun test`.
 */
const BUN_DISCOVERS = /(\.|_)(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Shapes that LOOK like a suite to a human but that bun does not discover. Detection is deliberately
 * two-part, because a name-only rule produced a false refusal in the sibling implementation of this
 * checker: `src/model-spec.ts` is a module about model SPECIFICATIONS, not a suite. So an
 * ambiguously-named file counts only when it actually imports a test runner -- a measurement of the
 * file rather than a hand-maintained list of exceptions.
 */
const LOOKS_LIKE_SUITE = /(-(test|spec)\.|^(test|spec)-)[a-z0-9.-]*\.?(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RUNNER_IMPORT = /from\s+["'](bun:test|node:test|vitest|uvu|tap|@jest\/globals)["']|require\(["'](bun:test|node:test|vitest)["']\)/;

interface Findings {
  /** Files bun will execute given a bare `bun test`. */
  discovered: string[];
  /** Files that hold tests but that bun's name-based discovery cannot see. */
  undiscoverable: string[];
  unreadable: string[];
}

async function walk(root: string): Promise<Findings> {
  const discovered: string[] = [];
  const undiscoverable: string[] = [];
  const unreadable: string[] = [];
  /** Realpaths already walked. A symlink cycle terminates here instead of hanging the gate. */
  const visited = new Set<string>();

  const visit = async (dir: string): Promise<void> => {
    let canonical: string;
    try {
      canonical = await realpath(dir);
    } catch {
      canonical = dir;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (failure) {
      // ENOENT is the only benign reason a directory yields nothing. A permission or IO error read as
      // "no suites here" would put a silent-failure path inside the control whose entire job is
      // removing silent failures.
      const code = (failure as { code?: string }).code;
      if (code !== "ENOENT") unreadable.push(`${relative(root, dir) || "."} (${code ?? "unknown"})`);
      return;
    }
    for (const entry of entries) {
      if (SUITE_SEARCH_EXCLUDES.includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // bun follows these (MEASURED), so following them is what keeps the inventory truthful.
        // Files reached this way are inventoried under their link path, which is how bun names them.
        let target: Dirent[] | undefined;
        try {
          target = await readdir(full, { withFileTypes: true });
        } catch {
          target = undefined;
        }
        if (target !== undefined) await visit(full);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (BUN_DISCOVERS.test(entry.name)) {
        discovered.push(relative(root, full));
      } else if (LOOKS_LIKE_SUITE.test(entry.name)) {
        let text: string;
        try {
          text = await readFile(full, "utf8");
        } catch {
          // Unreadable and ambiguously named: report it rather than assume it is harmless.
          undiscoverable.push(relative(root, full));
          continue;
        }
        if (RUNNER_IMPORT.test(text)) undiscoverable.push(relative(root, full));
      }
    }
  };
  await visit(root);
  return { discovered: discovered.sort(), undiscoverable: undiscoverable.sort(), unreadable };
}

interface Stage {
  name: string;
  command: string;
  /** Explicit path arguments handed to `bun test`. */
  paths: string[];
  /** `--path-ignore-patterns` values. */
  ignores: string[];
  /** True when the stage runs `bun test` with no explicit path, i.e. scans the whole tree. */
  scansTree: boolean;
}

/** Flags whose VALUE is the following token, so the value is never mistaken for a path. */
const VALUE_FLAGS = new Set([
  "--path-ignore-patterns",
  "--test-name-pattern",
  "--timeout",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--preload",
  "-p",
  "--concurrency",
]);

function parseStage(name: string, command: string): Stage {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  const paths: string[] = [];
  const ignores: string[] = [];
  let sawBunTest = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "bun" && tokens[i + 1] === "test") {
      sawBunTest = true;
      i += 1;
      continue;
    }
    if (!sawBunTest) continue;
    if (token === "&&" || token === "||" || token === ";") {
      sawBunTest = false;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = tokens[i + 1];
      if (value !== undefined && token === "--path-ignore-patterns") ignores.push(stripQuotes(value));
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    paths.push(stripQuotes(token));
  }
  return { name, command, paths, ignores, scansTree: /\bbun\s+test\b/.test(command) && paths.length === 0 };
}

function stripQuotes(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

/** Scripts reachable from the gate script by `bun run` / `npm run` / `pnpm run`, transitively. */
function reachableScripts(scripts: Record<string, string>, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const command = scripts[name];
    if (command === undefined) continue;
    for (const match of command.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
      queue.push(match[1] as string);
    }
  }
  return seen;
}

export async function findSuiteCoverageProblems(root: string): Promise<string[]> {
  const problems: string[] = [];

  let scripts: Record<string, string>;
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch (failure) {
    const detail = (failure as { code?: string }).code ?? (failure as Error).message;
    return [
      `package.json could not be read or parsed (${detail}). Without it no stage can be verified, and ` +
        `an unverifiable stage is not a passing one.`,
    ];
  }

  const stages: Stage[] = [];
  for (const name of DECLARED_SUITE_STAGES) {
    const command = scripts[name];
    if (command === undefined) {
      problems.push(
        `declared suite stage "${name}" does not exist in package.json scripts. A declaration ` +
          `pointing at a missing stage means the suites it claimed to run are run by nothing.`,
      );
      continue;
    }
    stages.push(parseStage(name, command));
  }

  // The original bite: a stage that exists, is correct, and is invoked by nothing.
  const reachable = reachableScripts(scripts, GATE_SCRIPT);
  for (const stage of stages) {
    if (!reachable.has(stage.name)) {
      problems.push(
        `stage "${stage.name}" is never reached from "${GATE_SCRIPT}". A suite stage nobody invokes is ` +
          `the exact defect this check exists for: the gate stays green while the tests never run.`,
      );
    }
  }

  const { discovered, undiscoverable, unreadable } = await walk(root);

  // Every discovered file must actually be executed by some declared stage.
  const isRunBy = (file: string, stage: Stage): boolean => {
    if (stage.paths.some((p) => p.replace(/^\.\//, "") === file)) return true;
    if (!stage.scansTree) return false;
    return !stage.ignores.some((pattern) => file.includes(stripQuotes(pattern)));
  };
  const orphans = discovered.filter((file) => !stages.some((stage) => isRunBy(file, stage)));
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} suite file(s) that no declared stage runs: ${orphans.join(", ")}. ` +
        `Either a stage ignores them via --path-ignore-patterns with no other stage picking them up, ` +
        `or they sit outside every stage's paths. Tests nobody executes are not coverage.`,
    );
  }

  // (1) names bun cannot see.
  if (undiscoverable.length > 0) {
    problems.push(
      `${undiscoverable.length} file(s) import a test runner but do NOT match bun's discovery ` +
        `patterns: ${undiscoverable.join(", ")}. MEASURED: bun runs \`.test.\`/\`_test.\`/\`.spec.\`/` +
        `\`_spec.\` and silently skips hyphenated names such as \`d-test.ts\` and \`test-g.ts\`. ` +
        `Rename to a discoverable form.`,
    );
  }

  if (unreadable.length > 0) {
    problems.push(
      `${unreadable.length} directory/ies could not be read: ${unreadable.join(", ")}. An unreadable ` +
        `directory is not an empty one, and treating it as empty is how a suite hides.`,
    );
  }

  return problems;
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? ".");
  const problems = await findSuiteCoverageProblems(root);
  if (problems.length > 0) {
    console.error(`check-suite-coverage: FAILED in ${root}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const { discovered } = await walk(root);
  console.log(
    `check-suite-coverage: ok (${discovered.length} suite file(s); every one executed by a stage ` +
      `reachable from "${GATE_SCRIPT}")`,
  );
}

if (process.argv[1] && /check-suite-coverage\.[a-z]+$/.test(resolve(process.argv[1]))) await main();
