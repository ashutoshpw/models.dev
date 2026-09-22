#!/usr/bin/env bun
// Generates the capability coverage report for the catalog.
//
// Usage:
//   bun packages/core/script/capability-coverage.ts [--json] [--check]
//
// --json   print the machine-readable report instead of writing markdown
// --check  exit non-zero when docs/capabilities/coverage.md is stale

import path from "node:path";

import { generateCatalog } from "../src/generate.js";
import {
  CapabilityFeatureValues,
  CapabilityInputValues,
  CapabilityTaskValues,
  OperationValues,
  TransportValues,
} from "../src/schema.js";
import type {
  CapabilityStatus,
  CapabilityTaskValue,
} from "../src/schema.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const outputPath = path.join(root, "docs", "capabilities", "coverage.md");
const staleAfterMs = 365 * 24 * 60 * 60 * 1000;

const STATUSES: CapabilityStatus[] = ["supported", "unsupported", "unknown"];

type CapabilityNode = {
  status?: CapabilityStatus;
  evidence?: string[];
  verified_at?: string;
};

interface DeclarationRecord {
  location: string;
  axis: string;
  key: string;
  node: CapabilityNode;
}

function emptyCounts(): Record<CapabilityStatus, number> {
  return { supported: 0, unsupported: 0, unknown: 0 };
}

function isEmptyGroup(value: unknown): boolean {
  return value === undefined || Object.keys(value as object).length === 0;
}

function collectDeclarations(
  location: string,
  capabilities: Record<string, unknown> | undefined,
): DeclarationRecord[] {
  if (capabilities === undefined) return [];
  const records: DeclarationRecord[] = [];
  const axes: Array<[string, unknown, readonly string[]]> = [
    ["tasks", capabilities.tasks, CapabilityTaskValues],
    ["inputs", capabilities.inputs, CapabilityInputValues],
    ["features", capabilities.features, CapabilityFeatureValues],
  ];
  const endpoints = capabilities.endpoints as Record<string, unknown> | undefined;
  if (endpoints !== undefined) {
    axes.push(["endpoints.transports", endpoints.transports, TransportValues]);
    axes.push(["endpoints.operations", endpoints.operations, OperationValues]);
  }

  for (const [axis, group, keys] of axes) {
    if (group === undefined || group === null || typeof group !== "object") {
      continue;
    }
    for (const key of keys) {
      const node = (group as Record<string, CapabilityNode | undefined>)[key];
      if (node?.status !== undefined) {
        records.push({ location, axis, key, node });
      }
    }
  }
  return records;
}

function coverageFor<const K extends string>(
  keys: readonly K[],
  declarations: DeclarationRecord[],
  axis: string,
) {
  return keys.map((key) => {
    const counts = emptyCounts();
    for (const record of declarations) {
      if (record.axis === axis && record.key === key) counts[record.node.status!]++;
    }
    return { key, counts };
  });
}

const catalog = await generateCatalog(root);

const canonicalDeclarations: DeclarationRecord[] = [];
for (const [modelID, model] of Object.entries(catalog.models)) {
  canonicalDeclarations.push(
    ...collectDeclarations(`models:${modelID}`, model.capabilities as Record<string, unknown> | undefined),
  );
}

const providerDeclarations: DeclarationRecord[] = [];
for (const [providerID, provider] of Object.entries(catalog.providers)) {
  for (const [modelID, model] of Object.entries(provider.models)) {
    providerDeclarations.push(
      ...collectDeclarations(
        `${providerID}/${modelID}`,
        model.capabilities as Record<string, unknown> | undefined,
      ),
    );
  }
}

const allDeclarations = [...canonicalDeclarations, ...providerDeclarations];

const taskCoverage = coverageFor(CapabilityTaskValues, canonicalDeclarations, "tasks");
const featureCoverage = coverageFor(CapabilityFeatureValues, canonicalDeclarations, "features");
const inputCoverage = coverageFor(CapabilityInputValues, canonicalDeclarations, "inputs");

const providerTaskDeclarations = new Map<CapabilityTaskValue, number>();
for (const record of providerDeclarations) {
  if (record.axis !== "tasks") continue;
  const key = record.key as CapabilityTaskValue;
  providerTaskDeclarations.set(key, (providerTaskDeclarations.get(key) ?? 0) + 1);
}

const transportCoverage = coverageFor(TransportValues, providerDeclarations, "endpoints.transports");
const operationCoverage = coverageFor(OperationValues, providerDeclarations, "endpoints.operations");

const formatSet = new Set<string>();
for (const [modelID, model] of Object.entries(catalog.models)) {
  const formats = model.capabilities?.inputs?.files?.formats;
  if (formats === undefined) continue;
  for (const format of formats) formatSet.add(`${format} (${modelID})`);
}
for (const [, provider] of Object.entries(catalog.providers)) {
  for (const [modelID, model] of Object.entries(provider.models)) {
    const formats = model.capabilities?.inputs?.files?.formats;
    if (formats === undefined) continue;
    for (const format of formats) formatSet.add(`${format} (provider)`);
  }
}

const missingEvidence = allDeclarations.filter(
  (record) =>
    record.node.status !== "unknown" &&
    ((record.node.evidence?.length ?? 0) === 0 || record.node.verified_at === undefined),
);
const now = Date.now();
const staleDeclarations = allDeclarations.filter((record) => {
  if (record.node.verified_at === undefined) return false;
  const verified = Date.parse(`${record.node.verified_at}T00:00:00Z`);
  return Number.isFinite(verified) && now - verified > staleAfterMs;
});

const canonicalTaskDeclared = new Set<string>();
for (const [modelID, model] of Object.entries(catalog.models)) {
  const tasks = model.capabilities?.tasks;
  if (!isEmptyGroup(tasks)) {
    canonicalTaskDeclared.add(modelID);
  }
}

const gapsByLab = new Map<string, number>();
for (const modelID of Object.keys(catalog.models)) {
  if (canonicalTaskDeclared.has(modelID)) continue;
  const lab = modelID.includes("/") ? modelID.slice(0, modelID.indexOf("/")) : "(unknown)";
  gapsByLab.set(lab, (gapsByLab.get(lab) ?? 0) + 1);
}
const gapTotal = [...gapsByLab.values()].reduce((sum, value) => sum + value, 0);
const topGapLabs = [...gapsByLab.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 15);

const aliasCount = Object.keys(catalog.aliases).length;

const report = {
  schema_version: catalog.schema_version,
  generated_from: "models/ and providers/ TOML sources",
  counts: {
    canonical_models: Object.keys(catalog.models).length,
    provider_models: Object.values(catalog.providers).reduce(
      (sum, provider) => sum + Object.keys(provider.models).length,
      0,
    ),
    aliases: aliasCount,
    declarations: allDeclarations.length,
  },
  tasks: taskCoverage.map(({ key, counts }) => ({
    task: key,
    canonical: counts,
    provider_declarations: providerTaskDeclarations.get(key) ?? 0,
  })),
  features: featureCoverage.map(({ key, counts }) => ({ feature: key, canonical: counts })),
  inputs: inputCoverage.map(({ key, counts }) => ({ input: key, canonical: counts })),
  transports: transportCoverage.map(({ key, counts }) => ({ transport: key, provider: counts })),
  operations: operationCoverage.map(({ key, counts }) => ({ operation: key, provider: counts })),
  formats: [...formatSet].sort(),
  evidence: {
    declarations: allDeclarations.length,
    missing_evidence: missingEvidence.map((record) => `${record.location} ${record.axis}.${record.key}`),
    stale_verified_at: staleDeclarations.map(
      (record) => `${record.location} ${record.axis}.${record.key} (${record.node.verified_at})`,
    ),
  },
  gaps: {
    canonical_models_without_tasks: gapTotal,
    by_lab: topGapLabs.map(([lab, count]) => ({ lab, count })),
  },
};

function tableRow(cells: Array<string | number>) {
  return `| ${cells.join(" | ")} |`;
}

function statusCells(counts: Record<CapabilityStatus, number>) {
  return STATUSES.map((status) => counts[status]);
}

function renderMarkdown() {
  const lines: string[] = [];
  lines.push("# Capability Coverage");
  lines.push("");
  lines.push(
    "Generated by `bun run coverage:capabilities`. Do not edit by hand.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(tableRow(["Metric", "Value"]));
  lines.push(tableRow(["---", "---"]));
  lines.push(tableRow(["Canonical models", report.counts.canonical_models]));
  lines.push(tableRow(["Provider model entries", report.counts.provider_models]));
  lines.push(tableRow(["Aliases", report.counts.aliases]));
  lines.push(tableRow(["Capability declarations", report.counts.declarations]));
  lines.push(tableRow(["Declarations missing evidence", report.evidence.missing_evidence.length]));
  lines.push(tableRow(["Declarations verified > 12 months ago", report.evidence.stale_verified_at.length]));
  lines.push("");
  lines.push(
    "Unknown is the absence of a declaration, so the `unknown` column is the",
    "remaining gap per axis. Provider declarations include inherited canonical",
    "defaults, so they measure resolved coverage, not authored overrides.",
  );
  lines.push("");
  lines.push("## Tasks (canonical models)");
  lines.push("");
  lines.push(tableRow(["Task", "Supported", "Unsupported", "Unknown", "Provider entries with task"]));
  lines.push(tableRow(["---", "---", "---", "---", "---"]));
  const totalModels = report.counts.canonical_models;
  for (const row of report.tasks) {
    const unknown = totalModels - row.canonical.supported - row.canonical.unsupported;
    lines.push(tableRow([row.task, row.canonical.supported, row.canonical.unsupported, unknown, row.provider_declarations]));
  }
  lines.push("");
  lines.push("## Features (canonical models)");
  lines.push("");
  lines.push(tableRow(["Feature", "Supported", "Unsupported", "Unknown"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  for (const row of report.features) {
    const unknown = totalModels - row.canonical.supported - row.canonical.unsupported;
    lines.push(tableRow([row.feature, row.canonical.supported, row.canonical.unsupported, unknown]));
  }
  lines.push("");
  lines.push("## Inputs (canonical models)");
  lines.push("");
  lines.push(tableRow(["Input", "Supported", "Unsupported", "Unknown"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  for (const row of report.inputs) {
    const unknown = totalModels - row.canonical.supported - row.canonical.unsupported;
    lines.push(tableRow([row.input, row.canonical.supported, row.canonical.unsupported, unknown]));
  }
  lines.push("");
  lines.push("## Provider endpoints");
  lines.push("");
  lines.push("### Transports");
  lines.push("");
  lines.push(tableRow(["Transport", "Supported", "Unsupported", "Unknown"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  const providerModelTotal = report.counts.provider_models;
  for (const row of report.transports) {
    const unknown = providerModelTotal - row.provider.supported - row.provider.unsupported;
    lines.push(tableRow([row.transport, row.provider.supported, row.provider.unsupported, unknown]));
  }
  lines.push("");
  lines.push("### Operations");
  lines.push("");
  lines.push(tableRow(["Operation", "Supported", "Unsupported", "Unknown"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  for (const row of report.operations) {
    const unknown = providerModelTotal - row.provider.supported - row.provider.unsupported;
    lines.push(tableRow([row.operation, row.provider.supported, row.provider.unsupported, unknown]));
  }
  lines.push("");
  lines.push("## Declared file formats");
  lines.push("");
  if (report.formats.length === 0) {
    lines.push("_None declared._");
  } else {
    for (const format of report.formats) lines.push(`- \`${format}\``);
  }
  lines.push("");
  lines.push("## Gaps");
  lines.push("");
  lines.push(
    `${report.gaps.canonical_models_without_tasks} canonical models have no task declarations (unknown).`,
  );
  lines.push("");
  lines.push(tableRow(["Lab", "Models without task metadata"]));
  lines.push(tableRow(["---", "---"]));
  for (const row of report.gaps.by_lab) {
    lines.push(tableRow([row.lab, row.count]));
  }
  if (report.evidence.missing_evidence.length > 0) {
    lines.push("");
    lines.push("### Declarations missing evidence (validation blockers)");
    lines.push("");
    for (const item of report.evidence.missing_evidence) lines.push(`- ${item}`);
  }
  if (report.evidence.stale_verified_at.length > 0) {
    lines.push("");
    lines.push("### Stale verifications (informational)");
    lines.push("");
    for (const item of report.evidence.stale_verified_at) lines.push(`- ${item}`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const markdown = renderMarkdown();
  const current = Bun.file(outputPath);
  const isCurrent = (await current.exists()) && (await current.text()) === markdown;
  if (process.argv.includes("--check")) {
    if (!isCurrent) {
      console.error(
        `Capability coverage report is stale: run "bun run coverage:capabilities" and commit ${path.relative(root, outputPath)}`,
      );
      process.exit(1);
    }
    console.log("Capability coverage report is up to date");
  } else if (isCurrent) {
    console.log("Capability coverage report unchanged");
  } else {
    await Bun.write(outputPath, markdown);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  }
}
