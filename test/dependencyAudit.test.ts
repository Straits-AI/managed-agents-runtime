import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
  evaluateDependencyAudit,
  parseDependencyAuditExceptions,
} from '../src/dependencyAudit.js';

const empty = parseDependencyAuditExceptions({ schemaVersion: 1, exceptions: [] });

function report(severity?: 'high' | 'critical') {
  return {
    auditReportVersion: 2,
    vulnerabilities: severity ? {
      axios: {
        name: 'axios',
        severity,
        via: [{
          url: 'https://github.com/advisories/GHSA-fixture',
          dependency: 'axios',
          severity,
          title: 'fixture advisory',
        }],
      },
      wrapper: { name: 'wrapper', severity, via: ['axios'] },
    } : {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: severity === 'high' ? 2 : 0,
        critical: severity === 'critical' ? 2 : 0,
        total: severity ? 2 : 0,
      },
    },
  };
}

describe('dependency audit release policy', () => {
  it('passes a supported report with no high or critical production findings', () => {
    expect(evaluateDependencyAudit(
      report(),
      empty,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
    )).toMatchObject({ passed: true, findings: [], excepted: [], errors: [] });
  });

  it('fails high findings, including those reached through a wrapper dependency', () => {
    const result = evaluateDependencyAudit(
      report('high'),
      empty,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.errors).toContain(
      'high dependency vulnerability: axios https://github.com/advisories/GHSA-fixture',
    );
  });

  it('accepts only a matching, owned, reasoned, unexpired reviewed exception', () => {
    const exceptions = parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-fixture',
        package: 'axios',
        severity: 'high',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'temporary migration window',
      }],
    });
    const result = evaluateDependencyAudit(
      report('high'),
      exceptions,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
    );
    expect(result.passed).toBe(true);
    expect(result.excepted).toHaveLength(1);

    expect(evaluateDependencyAudit(
      report('high'),
      exceptions,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-21T00:00:00Z'),
    ).errors).toContain(
      'dependency exception expired: https://github.com/advisories/GHSA-fixture|axios|high',
    );
  });

  it('rejects stale exceptions and any exception-file change without a reviewed hash', () => {
    expect(() => parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-unscoped',
        package: 'left-pad',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'missing severity',
      }],
    })).toThrow(/exception is malformed/);
    expect(() => parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-impossible-date',
        package: 'left-pad',
        severity: 'high',
        expiresOn: '2026-02-31',
        owner: 'security@example.com',
        rationale: 'impossible calendar date',
      }],
    })).toThrow(/valid YYYY-MM-DD UTC date/);
    expect(() => parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-leap-day',
        package: 'left-pad',
        severity: 'high',
        expiresOn: '2028-02-29',
        owner: 'security@example.com',
        rationale: 'valid leap day',
      }],
    })).not.toThrow();
    const stale = parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-stale',
        package: 'left-pad',
        severity: 'high',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'fixture',
      }],
    });
    const result = evaluateDependencyAudit(
      report(),
      stale,
      '0'.repeat(64),
      new Date('2026-07-19T00:00:00Z'),
    );
    expect(result.errors).toContain(
      'dependency audit exceptions do not match the reviewed baseline',
    );
    expect(result.errors).toContain(
      'dependency exception is stale or unverifiable: https://github.com/advisories/GHSA-stale|left-pad|high',
    );
  });

  it.each([
    ['missing vulnerability map', { auditReportVersion: 2, metadata: report().metadata }],
    ['array vulnerability map', {
      auditReportVersion: 2,
      vulnerabilities: [],
      metadata: report().metadata,
    }],
    ['missing metadata', { auditReportVersion: 2, vulnerabilities: {} }],
    ['string counts', {
      ...report(),
      metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, high: '0' } },
    }],
    ['inconsistent counts', {
      ...report(),
      metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, high: 1 } },
    }],
    ['inconsistent total', {
      ...report(),
      metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, total: 1 } },
    }],
    ['malformed vulnerability evidence', {
      ...report('high'),
      vulnerabilities: {
        axios: { name: 'axios', severity: 'high', via: [{}] },
        wrapper: { name: 'wrapper', severity: 'high', via: ['axios'] },
      },
    }],
    ['unresolved vulnerability reference', {
      ...report('high'),
      vulnerabilities: {
        axios: { name: 'axios', severity: 'high', via: ['missing-package'] },
        wrapper: { name: 'wrapper', severity: 'high', via: ['axios'] },
      },
    }],
  ])('fails closed for %s', (_label, malformed) => {
    const result = evaluateDependencyAudit(
      malformed,
      empty,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects a high advisory hidden under a lower-severity container', () => {
    const result = evaluateDependencyAudit({
      auditReportVersion: 2,
      vulnerabilities: {
        axios: {
          name: 'axios',
          severity: 'moderate',
          via: [{
            url: 'https://github.com/advisories/GHSA-hidden-high',
            dependency: 'axios',
            severity: 'high',
            title: 'hidden high advisory',
          }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 1,
          high: 0,
          critical: 0,
          total: 1,
        },
      },
    }, empty, DEPENDENCY_AUDIT_EXCEPTIONS_SHA256, new Date('2026-07-19T00:00:00Z'));
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      findingId: 'https://github.com/advisories/GHSA-hidden-high',
      package: 'axios',
      severity: 'high',
    }));
    expect(result.errors).toContain('npm audit vulnerability severity is inconsistent: axios');
  });

  it('does not downgrade a critical container to its lower-severity advisory', () => {
    const exceptions = parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-only-high',
        package: 'axios',
        severity: 'high',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'fixture must not cover a critical container',
      }],
    });
    const result = evaluateDependencyAudit({
      auditReportVersion: 2,
      vulnerabilities: {
        axios: {
          name: 'axios',
          severity: 'critical',
          via: [{
            url: 'https://github.com/advisories/GHSA-only-high',
            dependency: 'axios',
            severity: 'high',
            title: 'high advisory under critical package',
          }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 1,
          total: 1,
        },
      },
    }, exceptions, DEPENDENCY_AUDIT_EXCEPTIONS_SHA256, new Date('2026-07-19T00:00:00Z'), 1);
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      findingId: 'package:axios',
      package: 'axios',
      severity: 'critical',
    }));
    expect(result.errors).toContain('critical dependency vulnerability: axios package:axios');
  });

  it('does not let a high exception cover duplicate critical advisory evidence', () => {
    const exceptions = parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-shared',
        package: 'shared-package',
        severity: 'high',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'high severity only',
      }],
    });
    const result = evaluateDependencyAudit({
      auditReportVersion: 2,
      vulnerabilities: {
        criticalWrapper: {
          name: 'criticalWrapper',
          severity: 'critical',
          via: [{
            url: 'https://github.com/advisories/GHSA-shared',
            dependency: 'shared-package',
            severity: 'critical',
            title: 'critical observation',
          }],
        },
        highWrapper: {
          name: 'highWrapper',
          severity: 'high',
          via: [{
            url: 'https://github.com/advisories/GHSA-shared',
            dependency: 'shared-package',
            severity: 'high',
            title: 'high observation',
          }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 1,
          total: 2,
        },
      },
    }, exceptions, DEPENDENCY_AUDIT_EXCEPTIONS_SHA256, new Date('2026-07-19T00:00:00Z'), 1);
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      findingId: 'https://github.com/advisories/GHSA-shared',
      package: 'shared-package',
      severity: 'critical',
    }));
  });

  it('accepts exit code 1 only for a valid report whose findings are all reviewed', () => {
    const exceptions = parseDependencyAuditExceptions({
      schemaVersion: 1,
      exceptions: [{
        findingId: 'https://github.com/advisories/GHSA-fixture',
        package: 'axios',
        severity: 'high',
        expiresOn: '2026-07-20',
        owner: 'security@example.com',
        rationale: 'temporary migration window',
      }],
    });
    expect(evaluateDependencyAudit(
      report('high'),
      exceptions,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
      1,
    ).passed).toBe(true);
    expect(evaluateDependencyAudit(
      report(),
      empty,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
      1,
    ).errors).toContain('npm audit command failed with exit code 1');
    expect(evaluateDependencyAudit(
      report('high'),
      exceptions,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
      2,
    ).errors).toContain('npm audit command failed with exit code 2');
    expect(evaluateDependencyAudit(
      report(),
      empty,
      DEPENDENCY_AUDIT_EXCEPTIONS_SHA256,
      new Date('2026-07-19T00:00:00Z'),
      null,
    ).errors).toContain('npm audit command failed with no exit code');
  });
});
