import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { RunRecord, SuiteRecord } from "../src/domain.js";
import { suiteChildrenMatchDefinition, suiteCertificationProjection, suiteCertificationState } from "../src/worker.js";
import { testRun } from "./helpers.js";

function fixture(): { suite: SuiteRecord; children: RunRecord[] } {
  const children = [testRun({ scenarioId: "V-A01" }), testRun({ scenarioId: "V-O01" })];
  return { children, suite: {
    id: randomUUID(), callerId: children[0]!.callerId, idempotencyKey: "suite-binding", requestHash: "a".repeat(64), state: "running",
    scenarioIds: ["V-A01", "V-O01"], runIds: children.map(run => run.id), nextScenarioIndex: 2,
    definition: { environment: children[0]!.environment, target: children[0]!.target, capturePolicy: children[0]!.capturePolicy,
      scenarios: children.map(run => ({ id: run.scenarioId!, version: run.scenarioVersion, support: "supported", unavailableReason: null })) },
    createdAt: new Date(), updatedAt: new Date(),
  } };
}

it("accepts the exact independently bound children and skips only declared unsupported slots", () => {
  const { suite, children } = fixture();
  expect(suiteChildrenMatchDefinition(suite, children, "voice-lab-user-1")).toBe(true);
  suite.definition.scenarios.splice(1, 0, { id: "V-F02", version: "vt00.scenarios.v1", support: "typed_unsupported", unavailableReason: "owning contract unavailable" });
  suite.nextScenarioIndex = 3;
  expect(suiteChildrenMatchDefinition(suite, children, "voice-lab-user-1")).toBe(true);
  suite.nextScenarioIndex = 0;
  suite.runIds = [];
  expect(suiteChildrenMatchDefinition(suite, [], "voice-lab-user-1")).toBe(true);
});

const cases: Array<[string, (suite: SuiteRecord, children: RunRecord[]) => void]> = [
  ["missing child", (_suite, children) => { children.pop(); }],
  ["duplicate run", (suite, children) => { children[1] = children[0]!; suite.runIds[1] = children[0]!.id; }],
  ["reused test identity", (_suite, children) => { children[1]!.testRunId = children[0]!.testRunId; }],
  ["reused cleanup identity", (_suite, children) => { children[1]!.cleanupObligationId = children[0]!.cleanupObligationId; }],
  ["foreign caller", (_suite, children) => { children[1]!.callerId = "foreign"; }],
  ["foreign principal", (_suite, children) => { children[1]!.principalId = "foreign"; }],
  ["all children under foreign principal", (_suite, children) => { children.forEach(run => { run.principalId = "foreign"; }); }],
  ["foreign environment", (_suite, children) => { children[1]!.environment = "staging"; }],
  ["wrong run order", (_suite, children) => { children.reverse(); }],
  ["wrong scenario", (_suite, children) => { children[1]!.scenarioId = "V-B01"; }],
  ["wrong scenario version", (_suite, children) => { children[1]!.scenarioVersion = "foreign"; }],
  ["wrong build", (_suite, children) => { children[1]!.target = { ...children[1]!.target, expectedDeployment: { ...children[1]!.target.expectedDeployment, frontend: "f".repeat(40) } }; }],
  ["wrong capture policy", (_suite, children) => { children[1]!.capturePolicy = { ...children[1]!.capturePolicy, rawAudio: true }; }],
  ["counter ahead", suite => { suite.nextScenarioIndex = 3; }],
  ["counter behind", suite => { suite.nextScenarioIndex = 1; }],
  ["negative counter", suite => { suite.nextScenarioIndex = -1; }],
];
it.each(cases)("rejects %s without rewriting the input evidence", (_name, mutate) => {
  const { suite, children } = fixture();
  mutate(suite, children);
  const before = JSON.stringify({ suite, children });
  expect(suiteChildrenMatchDefinition(suite, children, "voice-lab-user-1")).toBe(false);
  expect(JSON.stringify({ suite, children })).toBe(before);
});

it.each([
  { state: "active" as const, cleanupComplete: true },
  { state: "pending_external_evidence" as const, cleanupComplete: true },
  { state: "completed" as const, cleanupComplete: false },
])("does not certify cached pass verdicts before lifecycle settlement: %o", patch => {
  const run = testRun({ ...patch, verdicts: { harness: "pass", product: "pass", provider: "pass", auth: "pass", evidence: "pass" } });
  expect(suiteCertificationState([run])).toBe("pending");
  expect(suiteCertificationProjection([run])).toMatchObject({ status: "pending", harness_evidence_certified_count: 0 });
});

it("does not call an empty supported-child set certified", () => {
  expect(suiteCertificationProjection([])).toMatchObject({ status: "not_certified", outcome_label: "no_supported_children", harness_evidence_certified_count: 0 });
});

it("keeps terminal missing-evidence verdicts pending in both suite decisions", () => {
  const run = testRun({ state: "completed", cleanupComplete: true, verdicts: { harness: "unavailable", product: "unavailable", provider: "pass", auth: "pass", evidence: "unavailable" } });
  expect(suiteCertificationProjection([run]).status).toBe("pending");
  expect(suiteCertificationState([run])).toBe("pending");
});
