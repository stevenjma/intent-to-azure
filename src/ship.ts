/**
 * Stage [3b] ship — take a scaffold and make it a real, breathing GitHub repo
 * whose committed pipeline deploys to real Azure.
 *
 * The planning half ({@link shipSteps}) is pure and offline: it returns the exact
 * ordered git/gh commands that would create + push the repo (and optionally
 * trigger the deploy workflow). The executing half ({@link runShip}) writes the
 * scaffold to disk and runs those commands via a pluggable {@link CommandRunner}
 * — so the network/`gh`/`git` side is opt-in and fully testable.
 *
 * `azx` still makes NO Azure calls itself: the real `az deployment` happens inside
 * the pushed GitHub Actions workflow (OIDC), never here.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AppIntent, AzurePlan } from "./types.js";
import { buildScaffold, type ScaffoldFile, type ScaffoldOptions } from "./scaffold.js";

/** One planned/executed shell step. */
export interface ShipStep {
  /** Executable (e.g. `git`, `gh`). */
  cmd: string;
  /** Argument vector (never a shell string — no interpolation surprises). */
  args: string[];
  /** Human-readable description of the step's purpose. */
  description: string;
}

export interface ShipOptions extends ScaffoldOptions {
  /** Target GitHub repo, `owner/name`. Required to actually create a repo. */
  repo?: string;
  /** Create the repo as private (default) vs public. */
  visibility?: "private" | "public";
  /** After push, trigger the deploy workflow (`gh workflow run deploy.yml`). */
  deploy?: boolean;
  /** Local directory to write the scaffold into (defaults to a repo-named dir). */
  outDir?: string;
}

export interface ShipPlan {
  /** The full repo tree that will be written. */
  files: ScaffoldFile[];
  /** Ordered git/gh commands that would create + push (+ optionally deploy). */
  steps: ShipStep[];
  /** Where the scaffold is written on disk. */
  outDir: string;
  /** The target repo slug, if one was provided. */
  repo?: string;
}

export interface ShipResult extends ShipPlan {
  /** Whether the steps were actually executed (vs. dry-run planned). */
  executed: boolean;
}

/** Pluggable command executor so `runShip` is testable without real git/gh. */
export type CommandRunner = (step: ShipStep, cwd: string) => void;

/**
 * Guard: refuse to write a scaffold into a directory that already holds files we
 * don't own. Both the real ship (which creates + pushes a repo) and the dry-run
 * `--out` writer use this so neither can clobber or publish unrelated files/secrets.
 */
export function assertEmptyOutDir(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(
      `output directory ${dir} already exists and is not empty — refusing to write the ` +
        `scaffold over it. Point --out at a new/empty directory.`,
    );
  }
}

/**
 * Write a scaffold file tree under `dir`, creating parent directories. Shell
 * scripts (`*.sh`) are written executable so the shipped OIDC setup script can be
 * run directly. Shared by {@link runShip} and the CLI's dry-run `--out` writer.
 */
export function writeScaffoldFiles(dir: string, files: ScaffoldFile[]): void {
  for (const file of files) {
    const abs = join(dir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, file.path.endsWith(".sh") ? { mode: 0o755 } : undefined);
  }
}

/** Local directory the scaffold is written to for a given repo/options. */
export function shipOutDir(intent: AppIntent, opts: ShipOptions = {}): string {
  if (opts.outDir) return resolve(opts.outDir);
  const name = opts.repo ? opts.repo.split("/").pop()! : intent.app.name;
  return resolve(`azx-deploy-${name}`);
}

/**
 * Plan the ship: build the scaffold and the ordered git/gh commands. Pure —
 * no filesystem, no network. Callers render this as a dry-run or feed it to
 * {@link runShip}.
 */
export function shipSteps(
  intent: AppIntent,
  plan: AzurePlan,
  bicep: string,
  opts: ShipOptions = {},
): ShipPlan {
  const files = buildScaffold(intent, plan, bicep, opts);
  const outDir = shipOutDir(intent, opts);
  const visibility = opts.visibility ?? "private";

  const steps: ShipStep[] = [
    { cmd: "git", args: ["init", "-b", "main"], description: "initialize a git repo on the main branch" },
    {
      cmd: "git",
      // Stage ONLY the files azx generated — never `git add -A`. The scaffold lands in
      // a dedicated dir (see runShip's empty-dir guard), but staging by explicit path
      // means even a stray/pre-existing file can't be committed and pushed by accident.
      args: ["add", "--", ...files.map((f) => f.path)],
      description: "stage the generated scaffold files",
    },
    {
      cmd: "git",
      args: ["commit", "-m", "chore: azx-generated infrastructure + deploy pipeline"],
      description: "commit the scaffold",
    },
  ];

  if (opts.repo) {
    steps.push({
      cmd: "gh",
      args: [
        "repo",
        "create",
        opts.repo,
        `--${visibility}`,
        "--source",
        ".",
        "--remote",
        "origin",
        "--push",
      ],
      description: `create the GitHub repo ${opts.repo} and push`,
    });
    if (opts.deploy) {
      steps.push({
        cmd: "gh",
        args: ["workflow", "run", "deploy.yml", "--repo", opts.repo],
        description: "trigger the deploy pipeline (runs the real Azure deploy)",
      });
    }
  }

  return { files, steps, outDir, repo: opts.repo };
}

/** Default runner: execute a step synchronously, inheriting stdio, failing loud. */
function defaultRunner(): CommandRunner {
  return (step, cwd) => {
    const res = spawnSync(step.cmd, step.args, { cwd, stdio: "inherit", shell: false });
    if (res.error) throw res.error;
    if (typeof res.status === "number" && res.status !== 0) {
      throw new Error(`\`${step.cmd} ${step.args.join(" ")}\` exited with code ${res.status}`);
    }
  };
}

/**
 * Execute a ship plan: write every scaffold file under `outDir`, then run each
 * git/gh step in that directory. This is the ONLY side-effecting entry point;
 * callers must opt in (the CLI requires `--create-repo`). Pass a custom
 * {@link CommandRunner} to test without touching git/gh.
 */
export function runShip(
  intent: AppIntent,
  plan: AzurePlan,
  bicep: string,
  opts: ShipOptions = {},
  runner: CommandRunner = defaultRunner(),
): ShipResult {
  const planned = shipSteps(intent, plan, bicep, opts);

  // Refuse to publish into a dir that already holds files we don't own: `runShip`
  // creates a real repo and pushes it, so an existing dir could leak unrelated
  // files (or secrets) into the new public/private repo. Require new-or-empty.
  assertEmptyOutDir(planned.outDir);

  writeScaffoldFiles(planned.outDir, planned.files);

  for (const step of planned.steps) {
    runner(step, planned.outDir);
  }

  return { ...planned, executed: true };
}
