#!/usr/bin/env node
/**
 * Run Playwright E2E tests in randomized order to surface ordering-dependent flakes.
 *
 * Usage:
 *   node scripts/run-e2e-randomized.mjs [playwright args]
 *   E2E_SEED=42 node scripts/run-e2e-randomized.mjs --project=fast
 *
 * Sets a seed for reproducibility. The seed is printed at the start; rerun with
 * E2E_SEED=<value> to reproduce a specific ordering.
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Seeded random number generator (simple LCG)
function seededRandom(seed) {
  let state = seed;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Fisher-Yates shuffle with seed
function shuffle(array, seed) {
  const rng = seededRandom(seed);
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Recursively find all .spec.ts files
function findTestFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findTestFiles(fullPath, base));
    } else if (entry.endsWith(".spec.ts")) {
      // Store relative path from the base test directory
      files.push(fullPath.replace(base + "/", ""));
    }
  }
  return files;
}

const testDir = "test/e2e";
const seed = process.env.E2E_SEED ? parseInt(process.env.E2E_SEED, 10) : Date.now();
const pwArgs = process.argv.slice(2);

console.log(`\n🎲 Randomizing E2E test order with seed: ${seed}`);
console.log(`   (reproduce with: E2E_SEED=${seed} node scripts/run-e2e-randomized.mjs)\n`);

// Find and shuffle test files
const testFiles = findTestFiles(testDir, testDir);
const shuffled = shuffle(testFiles, seed);

// Build the playwright command with explicit file list
const fileArgs = shuffled.map((f) => `${testDir}/${f}`).join(" ");
const cmd = `npx playwright test ${fileArgs} ${pwArgs.join(" ")}`;

console.log(`Running ${shuffled.length} test files in randomized order...\n`);

try {
  execSync(cmd, { stdio: "inherit" });
} catch (error) {
  process.exit(error.status || 1);
}
