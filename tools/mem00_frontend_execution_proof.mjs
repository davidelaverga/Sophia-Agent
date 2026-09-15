import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// A successful process exit alone does not establish that fixture-gated tests ran.
// Never return reporter text, test parameters, error messages or source paths.
export function frontendExecutionProof(raw, expectedTests) {
  assert(Number.isSafeInteger(expectedTests) && expectedTests > 0, 'frontend_expected_count_invalid');
  const report = JSON.parse(raw);
  assert.equal(report.success, true, 'frontend_report_failed');
  for (const [field, expected] of Object.entries({numTotalTests: expectedTests,
    numPassedTests: expectedTests, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0})) {
    assert.equal(report[field], expected, 'frontend_count_mismatch');
  }
  assert(Array.isArray(report.testResults), 'frontend_suites_missing');
  const cases = report.testResults.flatMap(suite => {
    assert.equal(suite.status, 'passed', 'frontend_suite_not_passed');
    assert(Array.isArray(suite.assertionResults), 'frontend_assertions_missing');
    return suite.assertionResults;
  });
  assert.equal(cases.length, expectedTests, 'frontend_assertion_count_mismatch');
  for (const item of cases) assert.equal(item.status, 'passed', 'frontend_assertion_not_passed');
  return {schema: 'mem00.frontend-execution.v1', tests: expectedTests, passed: expectedTests,
    failed: 0, skipped: 0, todo: 0,
    reporter_sha256: createHash('sha256').update(raw).digest('hex'),
    raw_report_exported: false};
}
