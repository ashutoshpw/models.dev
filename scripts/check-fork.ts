#!/usr/bin/env bun
// Fork guard for ashutoshpw/models.dev (upstream anomalyco/models.dev).
// Fails when a rebase or merge resolves toward upstream and drops the fork's
// deployment configuration. There is no rebrand here; the fork's delta is the
// Cloudflare target, the workflow guard, optional telemetry, and repo links.
//
// Modes:
//   --tree     every rule file in the working tree (CI / local audit); default
//   --staged   rule files as staged in the git index (pre-commit)
//
// Companion to .agents/skills/rebase-with-upstream/SKILL.md

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(new URL(import.meta.url).pathname),
  "..",
);

type Rule = {
  id: string;
  file: string;
  kind: "forbid" | "require";
  pattern: RegExp;
  hint: string;
};

const RULES: Rule[] = [
  {
    id: "fork-domain",
    file: "sst.config.ts",
    kind: "require",
    pattern: /models\.aistack\.run/,
    hint: 'the fork\'s Worker keeps domain "models.aistack.run"',
  },
  {
    id: "upstream-domain",
    file: "sst.config.ts",
    kind: "forbid",
    pattern: /"models\.dev"/,
    hint: '"models.dev" is the upstream domain; the fork serves models.aistack.run',
  },
  {
    id: "upstream-secret",
    file: "sst.config.ts",
    kind: "forbid",
    pattern: /sst\.Secret\(/,
    hint: "the fork links no PostHog/Lake secrets; telemetry is optional",
  },
  {
    id: "upstream-zone",
    file: "sst.config.ts",
    kind: "forbid",
    pattern: /opencode\.ai/,
    hint: "the models.opencode.ai custom domain belongs to upstream",
  },
  {
    id: "fork-deploy-guard",
    file: ".github/workflows/deploy.yml",
    kind: "require",
    pattern: /ashutoshpw\/models\.dev/,
    hint: "the deploy guard targets ashutoshpw/models.dev",
  },
  {
    id: "upstream-deploy-guard",
    file: ".github/workflows/deploy.yml",
    kind: "forbid",
    pattern: /anomalyco\/models\.dev/,
    hint: "the deploy guard must not target upstream",
  },
  {
    id: "account-id-variable",
    file: ".github/workflows/deploy.yml",
    kind: "require",
    pattern: /vars\.CLOUDFLARE_DEFAULT_ACCOUNT_ID/,
    hint: "the account id is a repository variable (vars.), not a secret",
  },
  {
    id: "account-id-secret",
    file: ".github/workflows/deploy.yml",
    kind: "forbid",
    pattern: /secrets\.CLOUDFLARE_DEFAULT_ACCOUNT_ID/,
    hint: "the account id must not be read from secrets",
  },
  {
    id: "telemetry-optional",
    file: "packages/function/src/worker.ts",
    kind: "require",
    pattern: /PosthogToken\?:/,
    hint: "telemetry envs stay optional in the fork",
  },
  {
    id: "telemetry-guarded",
    file: "packages/function/src/worker.ts",
    kind: "require",
    pattern: /env\.PosthogToken &&/,
    hint: "telemetry is skipped when the secrets are absent",
  },
  {
    id: "fork-links",
    file: "packages/web/src/render.tsx",
    kind: "require",
    pattern: /github\.com\/ashutoshpw\/models\.dev/,
    hint: "site links point at the fork repository",
  },
  {
    id: "upstream-links",
    file: "packages/web/src/render.tsx",
    kind: "forbid",
    pattern: /github\.com\/(?:sst|anomalyco)\/models\.dev/,
    hint: "site links must not point at the sst or anomalyco repository",
  },
  {
    id: "fork-brand",
    file: "packages/web/src/render.tsx",
    kind: "require",
    pattern: /AIStack models\.dev/,
    hint: 'user-facing copy is "AIStack models.dev"',
  },
  {
    id: "upstream-brand",
    file: "packages/web/src/render.tsx",
    kind: "forbid",
    pattern: /Models\.dev/,
    hint: 'bare "Models.dev" is upstream copy; the fork brands as "AIStack models.dev"',
  },
  {
    id: "fork-doc-domain",
    file: "packages/web/src/render.tsx",
    kind: "require",
    pattern: /https:\/\/models\.aistack\.run/,
    hint: "API examples point at the fork domain",
  },
  {
    id: "upstream-doc-domain",
    file: "packages/web/src/render.tsx",
    kind: "forbid",
    pattern: /https:\/\/models\.dev\//,
    hint: "API examples must not point at the upstream domain",
  },
  {
    id: "fork-og-image",
    file: "packages/web/index.html",
    kind: "require",
    pattern: /https:\/\/models\.aistack\.run\/social-share\.png/,
    hint: "og:image points at the fork domain",
  },
  {
    id: "upstream-og-image",
    file: "packages/web/index.html",
    kind: "forbid",
    pattern: /https:\/\/models\.dev\//,
    hint: "og:image must not point at the upstream domain",
  },
];

type Violation = {
  id: string;
  file: string;
  hint: string;
  line?: string;
  num?: number;
};

function readTreeFile(file: string): string | undefined {
  try {
    return NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8");
  } catch {
    return undefined;
  }
}

function readStagedFile(file: string): string | undefined {
  const result = NodeChildProcess.spawnSync("git", ["show", `:${file}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function checkFile(rule: Rule, content: string): Violation[] {
  const lines = content.split("\n");
  if (rule.kind === "require") {
    if (lines.some((line) => rule.pattern.test(line))) return [];
    return [{ id: rule.id, file: rule.file, hint: rule.hint }];
  }

  const violations: Violation[] = [];
  for (const [index, line] of lines.entries()) {
    if (!rule.pattern.test(line)) continue;
    violations.push({
      id: rule.id,
      file: rule.file,
      hint: rule.hint,
      line,
      num: index + 1,
    });
  }
  return violations;
}

function report(violations: Violation[], scope: string): number {
  console.error(
    `fork guard: ${violations.length} fork violation(s) found in this ${scope}. The fork deploys models.aistack.run from ashutoshpw/models.dev.`,
  );
  for (const violation of violations) {
    console.error(
      `\n  ${violation.id}  ${violation.file}${violation.num ? `:${violation.num}` : ""}`,
    );
    if (violation.line !== undefined) {
      console.error(`    + ${violation.line.trim()}`);
    }
    console.error(`    -> ${violation.hint}`);
  }
  console.error(
    `\nRestore the fork's configuration. Rules live in scripts/check-fork.ts;
resolution policy: .agents/skills/rebase-with-upstream/SKILL.md`,
  );
  return 1;
}

function usage(): number {
  console.error("usage: bun scripts/check-fork.ts [--tree | --staged]");
  return 2;
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) return usage();

  const staged = argv.includes("--staged");
  if (argv.some((arg) => arg !== "--staged" && arg !== "--tree")) return usage();

  const read = staged ? readStagedFile : readTreeFile;
  const scope = staged ? "staged change" : "tree";

  const contents = new Map<string, string | undefined>();
  for (const rule of RULES) {
    if (!contents.has(rule.file)) contents.set(rule.file, read(rule.file));
  }

  const violations: Violation[] = [];
  for (const [file, content] of contents) {
    if (content !== undefined) continue;
    violations.push({
      id: "missing-file",
      file,
      hint: "the fork rule file was deleted or renamed; restore it or update scripts/check-fork.ts",
    });
  }
  for (const rule of RULES) {
    const content = contents.get(rule.file);
    if (content === undefined) continue;
    violations.push(...checkFile(rule, content));
  }

  if (violations.length > 0) return report(violations, scope);
  process.stdout.write("fork guard: fork deployment invariants hold\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
