import { createHash } from 'node:crypto';

export const DEPENDENCY_AUDIT_EXCEPTIONS_SHA256 =
  'af779c1dea4c6b472330c33e22f55b6e880c3973478e0a3639ed3e4a9fa62ac4';

export interface DependencyAuditException {
  findingId: string;
  package: string;
  severity: DependencyAuditFinding['severity'];
  expiresOn: string;
  owner: string;
  rationale: string;
}

export interface DependencyAuditExceptions {
  schemaVersion: 1;
  exceptions: DependencyAuditException[];
}

export interface DependencyAuditFinding {
  findingId: string;
  package: string;
  severity: 'high' | 'critical';
  title: string;
}

export interface DependencyAuditEvaluation {
  passed: boolean;
  findings: DependencyAuditFinding[];
  excepted: DependencyAuditFinding[];
  errors: string[];
}

interface AuditAdvisory {
  url?: unknown;
  dependency?: unknown;
  severity?: unknown;
  title?: unknown;
}

interface AuditVulnerability {
  name?: unknown;
  severity?: unknown;
  via?: unknown;
}

interface AuditReport {
  auditReportVersion?: unknown;
  vulnerabilities?: unknown;
  metadata?: unknown;
}

export function dependencyAuditExceptionsSha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function expiryTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const roundTrip = new Date(timestamp);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) return null;
  return timestamp;
}

export function parseDependencyAuditExceptions(value: unknown): DependencyAuditExceptions {
  if (!value || typeof value !== 'object') {
    throw new Error('dependency audit exceptions must be an object');
  }
  const input = value as Partial<DependencyAuditExceptions>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.exceptions)) {
    throw new Error('dependency audit exceptions are malformed');
  }
  const exceptions = input.exceptions.map((candidate) => {
    if (
      !candidate || typeof candidate !== 'object' ||
      typeof candidate.findingId !== 'string' || !candidate.findingId ||
      typeof candidate.package !== 'string' || !candidate.package ||
      !highSeverity(candidate.severity) ||
      typeof candidate.expiresOn !== 'string' ||
      typeof candidate.owner !== 'string' || !candidate.owner.trim() ||
      typeof candidate.rationale !== 'string' || !candidate.rationale.trim()
    ) {
      throw new Error('dependency audit exception is malformed');
    }
    if (expiryTimestamp(candidate.expiresOn) === null) {
      throw new Error('dependency audit exception expiry must be a valid YYYY-MM-DD UTC date');
    }
    return candidate;
  });
  return { schemaVersion: 1, exceptions };
}

function highSeverity(value: unknown): value is DependencyAuditFinding['severity'] {
  return value === 'high' || value === 'critical';
}

const auditSeverities = ['info', 'low', 'moderate', 'high', 'critical'] as const;
const auditSeverityRank = new Map(auditSeverities.map((severity, rank) => [severity, rank]));

function auditSeverity(value: unknown): value is typeof auditSeverities[number] {
  return typeof value === 'string' && auditSeverities.includes(
    value as typeof auditSeverities[number],
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateAuditReport(rawReport: unknown): {
  vulnerabilities: Record<string, AuditVulnerability>;
  declaredHigh: number;
  declaredCritical: number;
  errors: string[];
} {
  const errors: string[] = [];
  if (!record(rawReport) || rawReport.auditReportVersion !== 2) {
    return {
      vulnerabilities: {},
      declaredHigh: 0,
      declaredCritical: 0,
      errors: ['npm audit report is missing or unsupported'],
    };
  }

  const report = rawReport as AuditReport;
  const vulnerabilities = record(report.vulnerabilities)
    ? report.vulnerabilities as Record<string, AuditVulnerability>
    : {};
  if (!record(report.vulnerabilities)) {
    errors.push('npm audit report vulnerabilities must be an object');
  }

  for (const [name, candidate] of Object.entries(vulnerabilities)) {
    if (!record(candidate) || candidate.name !== name || !auditSeverity(candidate.severity) ||
      !Array.isArray(candidate.via)) {
      errors.push(`npm audit vulnerability is malformed: ${name}`);
      continue;
    }
    for (const via of candidate.via) {
      if (typeof via === 'string' && via) continue;
      if (
        record(via) &&
        typeof via.url === 'string' && via.url &&
        typeof via.dependency === 'string' && via.dependency &&
        auditSeverity(via.severity)
      ) continue;
      errors.push(`npm audit vulnerability evidence is malformed: ${name}`);
      break;
    }
  }
  for (const [name, candidate] of Object.entries(vulnerabilities)) {
    if (!record(candidate) || !auditSeverity(candidate.severity) || !Array.isArray(candidate.via)) {
      continue;
    }
    const containerRank = auditSeverityRank.get(candidate.severity)!;
    for (const via of candidate.via) {
      const nestedSeverity = typeof via === 'string'
        ? vulnerabilities[via]?.severity
        : record(via)
          ? via.severity
          : undefined;
      if (!auditSeverity(nestedSeverity)) {
        if (typeof via === 'string') {
          errors.push(`npm audit vulnerability reference is unresolved: ${name} -> ${via}`);
        }
        continue;
      }
      if (auditSeverityRank.get(nestedSeverity)! > containerRank) {
        errors.push(`npm audit vulnerability severity is inconsistent: ${name}`);
        break;
      }
    }
  }

  const metadata = record(report.metadata) ? report.metadata : {};
  const counts = record(metadata.vulnerabilities) ? metadata.vulnerabilities : {};
  const requiredCounts = ['info', 'low', 'moderate', 'high', 'critical', 'total'] as const;
  const countsValid = record(report.metadata) && record(metadata.vulnerabilities) &&
    requiredCounts.every((severity) => nonnegativeInteger(counts[severity]));
  if (!countsValid) {
    errors.push('npm audit vulnerability metadata is malformed');
  }
  const declaredHigh = nonnegativeInteger(counts.high) ? counts.high : 0;
  const declaredCritical = nonnegativeInteger(counts.critical) ? counts.critical : 0;
  if (countsValid) {
    const observed = Object.fromEntries(
      auditSeverities.map((severity) => [
        severity,
        Object.values(vulnerabilities)
          .filter((candidate) => record(candidate) && candidate.severity === severity).length,
      ]),
    );
    if (
      auditSeverities.some((severity) => counts[severity] !== observed[severity]) ||
      counts.total !== Object.keys(vulnerabilities).length
    ) {
      errors.push('npm audit vulnerability metadata does not match vulnerability records');
    }
  }

  return { vulnerabilities, declaredHigh, declaredCritical, errors };
}

function collectFindings(
  vulnerabilities: Record<string, AuditVulnerability>,
): DependencyAuditFinding[] {
  const findings = new Map<string, DependencyAuditFinding>();
  const retainFinding = (finding: DependencyAuditFinding): void => {
    const key = `${finding.findingId}|${finding.package}`;
    const current = findings.get(key);
    if (!current || auditSeverityRank.get(finding.severity)! >
      auditSeverityRank.get(current.severity)!) {
      findings.set(key, finding);
    }
  };

  const reachableHighAdvisories = (name: string, visited = new Set<string>()): number => {
    if (visited.has(name)) return -1;
    visited.add(name);
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via)) return -1;
    let maximumRank = -1;
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        maximumRank = Math.max(maximumRank, reachableHighAdvisories(via, visited));
        continue;
      }
      if (!via || typeof via !== 'object') continue;
      const advisory = via as AuditAdvisory;
      if (
        typeof advisory.url === 'string' &&
        typeof advisory.dependency === 'string' &&
        highSeverity(advisory.severity)
      ) {
        retainFinding({
          findingId: advisory.url,
          package: advisory.dependency,
          severity: advisory.severity,
          title: typeof advisory.title === 'string' ? advisory.title : advisory.url,
        });
        maximumRank = Math.max(maximumRank, auditSeverityRank.get(advisory.severity)!);
      }
    }
    return maximumRank;
  };

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const reachableRank = reachableHighAdvisories(name);
    if (
      highSeverity(vulnerability.severity) &&
      reachableRank < auditSeverityRank.get(vulnerability.severity)!
    ) {
      retainFinding({
        findingId: `package:${name}`,
        package: name,
        severity: vulnerability.severity,
        title: `unresolved ${vulnerability.severity} vulnerability in ${name}`,
      });
    }
  }
  return [...findings.values()].sort((a, b) =>
    `${a.findingId}|${a.package}`.localeCompare(`${b.findingId}|${b.package}`),
  );
}

export function evaluateDependencyAudit(
  rawReport: unknown,
  exceptions: DependencyAuditExceptions,
  exceptionsSha256: string,
  now = new Date(),
  auditExitCode: number | null = 0,
): DependencyAuditEvaluation {
  const errors: string[] = [];
  if (exceptionsSha256 !== DEPENDENCY_AUDIT_EXCEPTIONS_SHA256) {
    errors.push('dependency audit exceptions do not match the reviewed baseline');
  }
  const validated = validateAuditReport(rawReport);
  errors.push(...validated.errors);
  const findings = collectFindings(validated.vulnerabilities);
  if (
    (validated.declaredHigh > 0 || validated.declaredCritical > 0) &&
    findings.length === 0
  ) {
    errors.push('npm reported high or critical vulnerabilities without advisory evidence');
  }

  const keys = new Set<string>();
  const excepted: DependencyAuditFinding[] = [];
  const expiryBoundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (const exception of exceptions.exceptions) {
    const key = `${exception.findingId}|${exception.package}|${exception.severity}`;
    if (keys.has(key)) errors.push(`duplicate dependency exception: ${key}`);
    keys.add(key);
    const expiresAt = expiryTimestamp(exception.expiresOn);
    if (expiresAt === null || expiresAt < expiryBoundary) {
      errors.push(`dependency exception expired: ${key}`);
    }
    const finding = findings.find((candidate) =>
      candidate.findingId === exception.findingId &&
      candidate.package === exception.package &&
      candidate.severity === exception.severity
    );
    if (!finding) errors.push(`dependency exception is stale or unverifiable: ${key}`);
    else excepted.push(finding);
  }

  for (const finding of findings) {
    if (!keys.has(`${finding.findingId}|${finding.package}|${finding.severity}`)) {
      errors.push(
        `${finding.severity} dependency vulnerability: ${finding.package} ${finding.findingId}`,
      );
    }
  }
  const everyFindingExcepted = findings.length > 0 && excepted.length === findings.length;
  if (
    auditExitCode !== 0 &&
    !(auditExitCode === 1 && everyFindingExcepted && errors.length === 0)
  ) {
    errors.push(
      `npm audit command failed with ${auditExitCode === null ? 'no exit code' : `exit code ${auditExitCode}`}`,
    );
  }
  return { passed: errors.length === 0, findings, excepted, errors };
}
