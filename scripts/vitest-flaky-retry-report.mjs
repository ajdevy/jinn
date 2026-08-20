import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A hook or collection failure names no test, so the file itself is the finding
 * and its `message` is the only detail there is. Dropping it would leave an
 * entry with a filename and nothing else.
 */
function entryDetails(entry) {
  if (entry.tests.length > 0) {
    return entry.tests;
  }
  const firstLine = entry.message.split("\n")[0].trim();
  return [`whole file${firstLine ? `: ${firstLine}` : ""}`];
}

function formatEntries(entries) {
  return entries.flatMap((entry) => [
    `  ${entry.file}`,
    ...entryDetails(entry).map((detail) => `    - ${detail}`),
  ]);
}

function formatFlakyReport(flaky) {
  const files = flaky.length === 1 ? "file" : "files";
  return [
    "",
    `⚠ FLAKY — ${flaky.length} test ${files} failed, then passed when rerun:`,
    ...formatEntries(flaky),
    "",
    "A flake is a bug to fix, not noise to ignore.",
    "",
  ].join("\n");
}

export function formatFlakySummary(flaky) {
  return [
    "## ⚠ FLAKY",
    "",
    "These failed on the first run and passed when rerun. A flake is a bug to fix, not noise to ignore.",
    "",
    ...flaky.flatMap((entry) => [
      `- \`${entry.file}\``,
      ...entryDetails(entry).map((detail) => `  - ${detail}`),
    ]),
    "",
  ].join("\n");
}

function formatStillFailingReport(stillFailing) {
  const files = stillFailing.length === 1 ? "file" : "files";
  return [
    "",
    `✖ STILL FAILING after a rerun — ${stillFailing.length} test ${files}:`,
    ...formatEntries(stillFailing),
    "",
  ].join("\n");
}

function annotate(entry, packageDir) {
  const fromRepoRoot = path
    .relative(repoRoot, path.resolve(packageDir, entry.file))
    .replaceAll("\\", "/");
  const detail = entry.tests.length > 0 ? entry.tests.join(", ") : "whole file";
  console.log(`::warning file=${fromRepoRoot}::FLAKY — passed only on a rerun (${detail})`);
}

function appendJobSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, markdown);
  }
}

export function report({ flaky, stillFailing, packageDir }) {
  if (flaky.length > 0) {
    console.log(formatFlakyReport(flaky));
    for (const entry of flaky) {
      annotate(entry, packageDir);
    }
    appendJobSummary(formatFlakySummary(flaky));
  }
  if (stillFailing.length > 0) {
    console.log(formatStillFailingReport(stillFailing));
  }
}
