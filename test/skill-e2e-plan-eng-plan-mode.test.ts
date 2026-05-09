/**
 * plan-eng-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. This file exercises the same contract against /plan-eng-review.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
  isProseAUQVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

// SEED_PLAN_FORCING_FINDINGS: 8+ files + custom-vs-builtin smell forces the
// Step 0 complexity check to trigger. Passed via runPlanSkillObservation's
// initialPlanContent (D3-B) so the spawned `claude` actually sees it.
const SEED_PLAN_FORCING_FINDINGS = `
# Parallelize unit tests

## Plan
Build a custom test runner: scripts/test-parallel.ts, scripts/test-shard-impl.ts,
scripts/test-merge-results.ts, scripts/test-progress.ts, scripts/test-watch.ts,
scripts/test-coverage.ts, scripts/test-cli.ts, scripts/test-config.ts.

Add new TestRunner class, new ShardManager class, new ResultMerger class.

Ignore Bun's native --shard flag because we want full control.

## Files
- scripts/test-parallel.ts (new)
- scripts/test-shard-impl.ts (new)
- scripts/test-merge-results.ts (new)
- scripts/test-progress.ts (new)
- scripts/test-watch.ts (new)
- scripts/test-coverage.ts (new)
- scripts/test-cli.ts (new)
- scripts/test-config.ts (new)
- package.json (add scripts)

## Tests
None planned — will add later.
`;

describeE2E('plan-eng-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-eng-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);

  // v1.21+ regression: see skill-e2e-plan-ceo-plan-mode.test.ts for the
  // contract. Pass envelope is ['asked', 'plan_ready']; failure signals
  // are 'auto_decided' (AUTO_DECIDE without opt-in) plus the standard
  // silent_write/exited/timeout.
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    // Surface visibility check (consistent with plan-ceo / plan-design /
    // autoplan migrations): user must SEE the question via a `## Decisions`
    // section in the plan file (legacy) OR a BLOCKED string in TTY OR
    // prose-rendered AUQ options in TTY.
    const blockedVisible = /BLOCKED\s*[—-]\s*AskUserQuestion/i.test(obs.evidence);
    const proseAUQVisible = isProseAUQVisible(obs.evidence) || obs.proseAUQEverObserved === true;
    const surfaceVisible = blockedVisible || proseAUQVisible || obs.waitingEverObserved === true;

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-eng-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'exited' && !surfaceVisible) {
      throw new Error(
        `plan-eng-review AskUserQuestion-blocked regression: outcome=exited without any visible question surface (no BLOCKED string, no prose-rendered AUQ options). Model quit silently.\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'plan_ready') {
      const decisionsOk = obs.planFile && planFileHasDecisionsSection(obs.planFile);
      if (!decisionsOk && !surfaceVisible) {
        throw new Error(
          `plan-eng-review AskUserQuestion-blocked regression: plan_ready without any visible question surface (no "## Decisions" section in ${obs.planFile ?? '<no plan file detected>'}, no BLOCKED string, no prose AUQ options) — Step 0 was silently skipped.\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
    }
    expect(['asked', 'plan_ready', 'exited']).toContain(obs.outcome);
    // NOTE: assertReportAtBottomIfPlanWritten intentionally not called —
    // see plan-ceo-plan-mode test 2 for the rationale. Under
    // --disallowedTools the model can't run the full review, so the
    // report-at-bottom contract doesn't apply here.
  }, 360_000);

  // D3-B / D4-B: when a plan with guaranteed-finding-triggering complexity
  // is seeded, the skill MUST fire AskUserQuestion (or fall back to a
  // Decisions section) before writing findings to the plan. The
  // wrote_findings_before_asking outcome catches the precise transcript bug
  // — model writes findings to the plan before any AUQ render.
  test('STOP gate fires when seeded plan forces Step 0 findings', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      initialPlanContent: SEED_PLAN_FORCING_FINDINGS,
      // Force the Conductor-style path: native AUQ disallowed → the model
      // must use mcp__*__AskUserQuestion (outcome='asked') or fall back to
      // writing Decisions ('plan_ready').
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    if (
      obs.outcome === 'wrote_findings_before_asking' ||
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `STOP-gate regression: outcome=${obs.outcome}\nsummary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB) ---\n${obs.evidence}`,
      );
    }

    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile || !planFileHasDecisionsSection(obs.planFile)) {
        throw new Error(
          `STOP-gate regression: plan_ready without ## Decisions section in ` +
            `${obs.planFile ?? '<no plan file>'} — gate skipped after ToolSearch.\n` +
            `--- evidence (last 2KB) ---\n${obs.evidence}`,
        );
      }
    }

    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);
});
