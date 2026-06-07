#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, formatCommandFailure } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

function printUsage() {
  console.log(
    "Usage:\n" +
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]",
  );
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    return raw?.trim() ? splitRawArgumentString(raw) : [];
  }
  return argv;
}

function parseCommandInput(argv) {
  return parseArgs(normalizeArgv(argv), {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["background", "wait"],
    aliasMap: {
      C: "cwd",
      m: "model",
    },
  });
}

function resolveCommandCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function ensureCodexAvailable(cwd) {
  const availability = binaryAvailable("codex", ["--version"], { cwd });
  if (!availability.available) {
    throw new Error(`Codex CLI is not available: ${availability.detail}`);
  }
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
  });
}

function runCodexReview(repoRoot, prompt, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adversarial-review-"));
  const outputPath = path.join(tempDir, "last-message.txt");
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "-C",
    repoRoot,
    "--output-schema",
    REVIEW_SCHEMA,
    "--output-last-message",
    outputPath,
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push("-");

  const result = spawnSync("codex", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const finalMessage = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !finalMessage) {
    throw new Error(
      formatCommandFailure({
        command: "codex",
        args,
        status: result.status ?? 1,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: null,
      }),
    );
  }

  return {
    status: result.status ?? 0,
    stderr: result.stderr ?? "",
    finalMessage,
  };
}

function parseStructuredOutput(finalMessage) {
  const rawOutput = String(finalMessage ?? "").trim();
  if (!rawOutput) {
    return { parsed: null, rawOutput, parseError: "Codex did not return a final message." };
  }

  try {
    return { parsed: JSON.parse(rawOutput), rawOutput, parseError: null };
  } catch (error) {
    return {
      parsed: null,
      rawOutput,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4;
}

function formatLineRange(finding) {
  if (!finding.line_start || !finding.line_end) {
    return "";
  }
  return finding.line_start === finding.line_end
    ? `:${finding.line_start}`
    : `:${finding.line_start}-${finding.line_end}`;
}

function renderReviewResult(parsedResult, targetLabel) {
  if (!parsedResult.parsed) {
    const lines = [
      "# Codex Adversarial Review",
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = parsedResult.parsed;
  const findings = Array.isArray(data.findings)
    ? [...data.findings].sort(
        (left, right) => severityRank(left.severity) - severityRank(right.severity),
      )
    : [];
  const lines = [
    "# Codex Adversarial Review",
    "",
    `Target: ${targetLabel}`,
    `Verdict: ${data.verdict ?? "unknown"}`,
    "",
    String(data.summary ?? "").trim() || "(no summary)",
    "",
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(
        `- [${finding.severity ?? "unknown"}] ${finding.title ?? "(untitled)"} (${finding.file ?? "unknown"}${lineSuffix})`,
      );
      if (finding.body) {
        lines.push(`  ${finding.body}`);
      }
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (Array.isArray(data.next_steps) && data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function handleAdversarialReview(argv) {
  const { options, positionals } = parseCommandInput(argv);
  const cwd = resolveCommandCwd(options);

  ensureCodexAvailable(cwd);
  ensureGitRepository(cwd);

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope,
  });
  const context = collectReviewContext(cwd, target);
  const focusText = positionals.join(" ").trim();
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = runCodexReview(context.repoRoot, prompt, {
    model: options.model,
  });
  const parsed = parseStructuredOutput(result.finalMessage);

  process.stdout.write(renderReviewResult(parsed, context.target.label));
  if (result.status !== 0) {
    process.exitCode = result.status;
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  if (subcommand !== "adversarial-review") {
    throw new Error(`Unsupported subcommand: ${subcommand}`);
  }

  await handleAdversarialReview(argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
