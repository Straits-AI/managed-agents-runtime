import type { Scenario } from './runner.js';

/**
 * Real-world use cases exercised against the live Managed Agents runtime.
 * Each is designed to (a) succeed with a modest model and bounded cost, and
 * (b) demonstrate a distinct platform capability worth a tutorial lesson.
 */
export const SCENARIOS: Record<string, Scenario> = {
  // ---------------------------------------------------------------------------
  'data-analysis': {
    id: 'data-analysis',
    title: 'Data analysis agent — CSV to summary report',
    teaches:
      'The core loop: seed data into the durable workspace, let the agent compute with real tools (python/bash), verify a required artifact exists, and retrieve it from TOS.',
    instructions:
      'You are a data analyst working in a Linux sandbox. Use python3 or shell tools to do real computation — never guess numbers. Keep your progress ledger updated.',
    goal:
      'The file sales.csv (columns: region,month,amount) is in your workspace. ' +
      '1) Compute total revenue, revenue per region, and the single best month by total revenue. ' +
      '2) Write REPORT.md with those figures clearly labelled. ' +
      '3) Call run_complete with artifacts ["REPORT.md"].',
    seedFiles: {
      'sales.csv':
        'region,month,amount\n' +
        'APAC,Jan,1200\nAPAC,Feb,1500\nAPAC,Mar,1800\n' +
        'EMEA,Jan,900\nEMEA,Feb,1100\nEMEA,Mar,1300\n' +
        'AMER,Jan,2000\nAMER,Feb,1700\nAMER,Mar,2100\n',
    },
    verifierPolicy: { requiredArtifacts: ['REPORT.md'] },
    maxSteps: 25,
    timeoutMs: 420_000,
  },

  // ---------------------------------------------------------------------------
  'code-gen': {
    id: 'code-gen',
    title: 'Coding agent — implement a utility and pass its tests',
    teaches:
      'Objective verification: the agent writes code, and completion is gated on a real test command exiting 0 in the sandbox — not on the model claiming success.',
    instructions:
      'You are a careful software engineer working in a Linux sandbox with python3 available. ' +
      'Write real, runnable code and verify it yourself with the shell before declaring completion.',
    goal:
      'Implement a Python module roman.py with a function to_roman(n) that converts an ' +
      'integer 1..3999 to a Roman numeral string. ' +
      'A test file test_roman.py is already in your workspace — make it pass. ' +
      'Run `python3 -m unittest test_roman` yourself to check, then call run_complete with ' +
      'artifacts ["roman.py"].',
    // unittest is in the Python stdlib — it always exists in the sandbox,
    // unlike pytest. Matching verification to the runtime is a real lesson
    // (an earlier pytest-based version failed here, correctly, because the
    // AIO image ships no pytest).
    seedFiles: {
      'test_roman.py':
        'import unittest\n' +
        'from roman import to_roman\n\n' +
        'class TestRoman(unittest.TestCase):\n' +
        '    def test_basic(self):\n' +
        "        cases = {1:'I',4:'IV',9:'IX',40:'XL',90:'XC',400:'CD'," +
        "1994:'MCMXCIV',3999:'MMMCMXCIX'}\n" +
        '        for n, expected in cases.items():\n' +
        '            self.assertEqual(to_roman(n), expected)\n\n' +
        "if __name__ == '__main__':\n" +
        '    unittest.main()\n',
    },
    verifierPolicy: {
      requiredArtifacts: ['roman.py'],
      command: 'python3 -m unittest test_roman',
    },
    maxSteps: 30,
    timeoutMs: 480_000,
  },

  // ---------------------------------------------------------------------------
  'approval-gated': {
    id: 'approval-gated',
    title: 'Governed operations agent — human-approved external write',
    teaches:
      'The governance story: a side-effecting external call is gated by a capability grant that requires human approval; the run suspends with zero compute, resumes on approval, and the write is recorded exactly once via a durable receipt.',
    instructions:
      'You are an operations agent. To register a result with an external system you must use ' +
      'external_http_request; that action requires human approval, so request it and wait.',
    goal:
      'Compute the sum of the integers in numbers.txt (one per line). ' +
      'Then register it by POSTing {"sum": <the sum>} to {{EXTERNAL}}/results using ' +
      'external_http_request (this needs human approval — request it and wait for the decision). ' +
      'After it succeeds, call run_complete with artifacts [].',
    seedFiles: { 'numbers.txt': '11\n22\n33\n44\n' }, // sum = 110
    grants: [
      { action: 'external.http.*', resource: '{{EXTERNAL}}', requiresApproval: true },
    ],
    externalSystem: true,
    autoApprove: true,
    maxSteps: 25,
    timeoutMs: 420_000,
  },

  // ---------------------------------------------------------------------------
  'doc-processing': {
    id: 'doc-processing',
    title: 'Document processing agent — extract structured data from prose',
    teaches:
      'A non-code knowledge-work domain: the agent reads an unstructured document from the ' +
      'workspace and produces a structured artifact (JSON), showing the runtime is workload-agnostic.',
    instructions:
      'You are a document-processing agent working in a Linux sandbox. Read the input file, ' +
      'extract the requested fields accurately, and write valid JSON.',
    goal:
      'Read meeting-notes.txt from your workspace. Extract every action item into ' +
      'actions.json as a JSON array of objects with keys "owner", "task", and "due". ' +
      'Validate it parses (e.g. with python3 -m json.tool), then call run_complete with ' +
      'artifacts ["actions.json"].',
    seedFiles: {
      'meeting-notes.txt':
        'Project sync — 14 July 2026\n\n' +
        'Attendees: Wei, Hana, Jayden.\n\n' +
        'Discussion: launch is slipping. We agreed on the following.\n' +
        '- Wei will finalise the pricing page by Friday.\n' +
        '- Hana to send the updated contract to legal by 18 July.\n' +
        '- Jayden owns migrating the database; target end of month.\n' +
        'Next sync: 21 July.\n',
    },
    verifierPolicy: {
      requiredArtifacts: ['actions.json'],
      command: 'python3 -m json.tool actions.json',
    },
    maxSteps: 25,
    timeoutMs: 420_000,
  },
};
