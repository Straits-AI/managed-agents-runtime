import { randomUUID } from 'node:crypto';

export interface VefaasProvisioningResponse {
  result: Record<string, unknown>;
  requestId: string | null;
}

export type VefaasProvisioningApi = (
  action: string,
  body: Record<string, unknown>,
) => Promise<VefaasProvisioningResponse>;

export interface PrivateSandboxApplicationPlan {
  name: string;
  description: string;
  image: string;
  command: string;
  port: number;
  cpuMilli: number;
  memoryMB: number;
  maxConcurrency: number;
  requestTimeoutSeconds: number;
  initializerSeconds: number;
  tags: ReadonlyArray<{ Key: string; Value: string }>;
}

export interface PrivateSandboxProvisioningReceipt {
  disposition: 'created' | 'reused';
  attemptId: string;
  functionId: string;
  stableRevisionNumber: number;
  releaseRecordId: string;
  requestIds: Array<{ action: string; requestId: string | null }>;
}

export interface PrivateSandboxCleanupReceipt {
  functionId: string;
  absent: true;
  requestIds: Array<{ action: string; requestId: string | null }>;
}

export class PrivateSandboxConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Private sandbox configuration readback mismatch: ${fields.join(',')}`);
    this.name = 'PrivateSandboxConfigurationError';
    this.fields = [...fields];
  }
}

const CODE_IMAGE =
  'enterprise-public-ap-southeast-1.cr.volces.com/vefaas-public/code-cli:0.0.7';
const MANAGED_TAGS = [
  { Key: 'managed-by', Value: 'managed-agents-runtime' },
  { Key: 'managed-purpose', Value: 'private-sandbox' },
] as const;

export function defaultPrivateSandboxApplicationPlan(
  name: string,
): PrivateSandboxApplicationPlan {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name)) {
    throw new Error('Private sandbox application name is invalid');
  }
  return {
    name,
    description: 'Private BytePlus runtime conformance application',
    image: CODE_IMAGE,
    command: '/opt/gem/run.sh',
    port: 8080,
    cpuMilli: 1000,
    memoryMB: 2048,
    maxConcurrency: 10,
    requestTimeoutSeconds: 900,
    initializerSeconds: 120,
    tags: MANAGED_TAGS,
  };
}

export async function provisionPrivateSandboxApplication(
  plan: PrivateSandboxApplicationPlan,
  api: VefaasProvisioningApi,
  dependencies: {
    sleep?: (milliseconds: number) => Promise<void>;
    attemptId?: string;
    ambiguousCreateInventoryAttempts?: number;
  } = {},
): Promise<PrivateSandboxProvisioningReceipt> {
  const attemptId = dependencies.attemptId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(attemptId)) {
    throw new Error('Private sandbox provisioning attempt ID is invalid');
  }
  const ambiguityAttempts = dependencies.ambiguousCreateInventoryAttempts ?? 5;
  if (!Number.isInteger(ambiguityAttempts)
    || ambiguityAttempts < 1
    || ambiguityAttempts > 10) {
    throw new Error('Ambiguous CreateFunction inventory attempt limit is invalid');
  }
  const sleep = dependencies.sleep ?? (async (milliseconds) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  const requestIds: Array<{ action: string; requestId: string | null }> = [];
  const call = async (action: string, body: Record<string, unknown>) => {
    const response = await api(action, body);
    requestIds.push({ action, requestId: response.requestId });
    return response.result;
  };

  const items = await listAllFunctionItems(call);
  const matches = items.filter((item) => isRecord(item) && item.Name === plan.name);
  if (matches.length > 1) {
    throw new Error('Multiple private sandbox applications matched the exact name');
  }
  if (matches.length === 1) {
    const functionId = boundedIdentifier(matches[0]?.Id);
    if (!functionId) throw new Error('Existing private sandbox application ID is invalid');
    const status = await call('GetReleaseStatus', { FunctionId: functionId });
    const stableRevisionNumber = positiveInteger(status.StableRevisionNumber);
    const releaseRecordId = boundedIdentifier(status.ReleaseRecordId);
    if (status.Status !== 'done' || stableRevisionNumber === null || !releaseRecordId) {
      throw new Error('Existing private sandbox application is not stably released');
    }
    const revision = await call('GetRevision', {
      FunctionId: functionId,
      RevisionNumber: stableRevisionNumber,
    });
    assertRevisionMatches(plan, functionId, revision, stableRevisionNumber);
    return {
      disposition: 'reused',
      attemptId,
      functionId,
      stableRevisionNumber,
      releaseRecordId,
      requestIds,
    };
  }

  let created: Record<string, unknown>;
  try {
    created = await call('CreateFunction', createBody(plan, attemptId));
  } catch (error) {
    let exactName: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < ambiguityAttempts; attempt += 1) {
      const afterCreate = await listAllFunctionItems(call);
      exactName = afterCreate.filter((item) => item.Name === plan.name);
      if (exactName.length > 0 || attempt === ambiguityAttempts - 1) break;
      await sleep(1_000);
    }
    const possible = exactName.filter((item) => hasTag(
      item.Tags,
      'provisioning-attempt',
      attemptId,
    ));
    if (possible.length === 1) {
      const possibleId = boundedIdentifier(possible[0]?.Id);
      if (!possibleId) {
        throw new Error('Ambiguous CreateFunction cleanup target was invalid');
      }
      await call('DeleteFunction', { Id: possibleId });
      const afterDelete = await listAllFunctionItems(call);
      if (!inventoryExcludes(afterDelete, plan.name, possibleId)) {
        throw new Error('Ambiguous CreateFunction cleanup was not verified');
      }
    } else if (possible.length > 1) {
      throw new Error('Ambiguous CreateFunction produced multiple exact-name resources');
    } else if (exactName.length > 0) {
      throw new Error('Ambiguous CreateFunction cleanup target was not proven disposable');
    }
    throw error;
  }
  const functionId = boundedIdentifier(created.Id);
  if (!functionId) throw new Error('CreateFunction returned an invalid function ID');

  try {
    const draft = await call('GetRevision', { FunctionId: functionId, RevisionNumber: 0 });
    assertRevisionMatches(plan, functionId, draft, 0);

    const released = await call('Release', {
      FunctionId: functionId,
      RevisionNumber: 0,
      Description: 'Initial private sandbox release',
      TargetTrafficWeight: 100,
      RollingStep: 100,
      MaxInstance: 1,
    });
    const initialReleaseRecordId = boundedIdentifier(released.ReleaseRecordId);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await call('GetReleaseStatus', { FunctionId: functionId });
      if (status.Status === 'done') {
        const stableRevisionNumber = positiveInteger(status.StableRevisionNumber);
        const releaseRecordId = boundedIdentifier(status.ReleaseRecordId)
          ?? initialReleaseRecordId;
        if (stableRevisionNumber !== 1 || !releaseRecordId) {
          throw new Error('Private sandbox release completion was incomplete');
        }
        const stable = await call('GetRevision', {
          FunctionId: functionId,
          RevisionNumber: stableRevisionNumber,
        });
        assertRevisionMatches(plan, functionId, stable, stableRevisionNumber);
        return {
          disposition: 'created',
          attemptId,
          functionId,
          stableRevisionNumber,
          releaseRecordId,
          requestIds,
        };
      }
      if (status.Status === 'failed') {
        throw new Error('Private sandbox application release failed');
      }
      if (status.Status !== 'inprogress' && status.Status !== 'pending') {
        throw new Error('Private sandbox application release status was invalid');
      }
      await sleep(2_000);
    }
    throw new Error('Private sandbox application release timed out');
  } catch (error) {
    try {
      await call('DeleteFunction', { Id: functionId });
      const after = await listAllFunctionItems(call);
      if (!inventoryExcludes(after, plan.name, functionId)) {
        throw new Error('created function still present');
      }
    } catch {
      const message = error instanceof Error ? error.message : 'unknown provisioning error';
      throw new Error(
        `Private sandbox provisioning failed and cleanup was not verified: ${message}`,
      );
    }
    throw error;
  }
}

export async function deletePrivateSandboxApplication(
  target: { functionId: string; name: string },
  api: VefaasProvisioningApi,
): Promise<PrivateSandboxCleanupReceipt> {
  if (!boundedIdentifier(target.functionId)
    || !/^[a-z][a-z0-9-]{2,62}$/.test(target.name)) {
    throw new Error('Private sandbox cleanup target is invalid');
  }
  const requestIds: Array<{ action: string; requestId: string | null }> = [];
  const call = async (action: string, body: Record<string, unknown>) => {
    const response = await api(action, body);
    requestIds.push({ action, requestId: response.requestId });
    return response.result;
  };
  const sandboxes = await call('ListSandboxes', {
    FunctionId: target.functionId,
    PageNumber: 1,
    PageSize: 100,
  });
  const active = Array.isArray(sandboxes.Sandboxes) ? sandboxes.Sandboxes : null;
  if (active === null || active.length !== 0 || sandboxes.Total !== 0) {
    throw new Error('Private sandbox application still has instances');
  }

  const before = await listAllFunctionItems(call);
  const exact = before.filter((item) => item.Id === target.functionId
    && item.Name === target.name
    && MANAGED_TAGS.every((tag) => hasTag(item.Tags, tag.Key, tag.Value)));
  if (exact.length !== 1) {
    throw new Error('Private sandbox cleanup target did not match exactly');
  }
  await call('DeleteFunction', { Id: target.functionId });
  const after = await listAllFunctionItems(call);
  if (!inventoryExcludes(after, target.name, target.functionId)) {
    throw new Error('Private sandbox application deletion was not verified');
  }
  return { functionId: target.functionId, absent: true, requestIds };
}

function createBody(
  plan: PrivateSandboxApplicationPlan,
  attemptId: string,
): Record<string, unknown> {
  return {
    Name: plan.name,
    Description: plan.description,
    Runtime: 'native/v1',
    FunctionType: 'sandbox',
    SourceType: 'image',
    Source: plan.image,
    Command: plan.command,
    Port: plan.port,
    CpuStrategy: 'always',
    CpuMilli: plan.cpuMilli,
    MemoryMB: plan.memoryMB,
    MaxConcurrency: plan.maxConcurrency,
    RequestTimeout: plan.requestTimeoutSeconds,
    InitializerSec: plan.initializerSeconds,
    ExclusiveMode: false,
    ProjectName: 'default',
    Tags: [
      ...plan.tags,
      { Key: 'provisioning-attempt', Value: attemptId },
    ],
    Envs: [],
    VpcConfig: {
      EnableVpc: false,
      EnableSharedInternetAccess: false,
      VpcId: '',
      SubnetIds: [],
      SecurityGroupIds: [],
    },
    TlsConfig: { EnableLog: false, TlsProjectId: '', TlsTopicId: '' },
    NasStorage: { EnableNas: false, NasConfigs: [] },
    TosMountConfig: { EnableTos: false, MountPoints: [] },
  };
}

function assertRevisionMatches(
  plan: PrivateSandboxApplicationPlan,
  functionId: string,
  revision: Record<string, unknown>,
  revisionNumber: number,
): void {
  const mismatches: string[] = [];
  const expected: Array<[string, unknown]> = [
    ['Id', functionId],
    ['Name', plan.name],
    ['Description', plan.description],
    ['FunctionType', 'sandbox'],
    ['Runtime', 'native/v1'],
    ['SourceType', 'image'],
    ['Source', plan.image],
    ['Command', plan.command],
    ['Port', plan.port],
    ['CpuStrategy', 'always'],
    ['CpuMilli', plan.cpuMilli],
    ['MemoryMB', plan.memoryMB],
    ['MaxConcurrency', plan.maxConcurrency],
    ['RequestTimeout', plan.requestTimeoutSeconds],
    ['InitializerSec', plan.initializerSeconds],
    ['ExclusiveMode', false],
    ['ProjectName', 'default'],
    ['RevisionNumber', revisionNumber],
  ];
  for (const [key, value] of expected) {
    if (revision[key] !== value) {
      mismatches.push(key);
    }
  }
  if (revision.InstanceType !== ''
    && revision.InstanceType !== undefined
    && revision.InstanceType !== null) {
    mismatches.push('InstanceType');
  }
  if (!Array.isArray(revision.Envs) || revision.Envs.length !== 0) {
    mismatches.push('Envs');
  }
  if (!plan.tags.every((tag) => hasTag(revision.Tags, tag.Key, tag.Value))) {
    mismatches.push('Tags');
  }
  if (!disabledVpc(revision.VpcConfig)) {
    mismatches.push('VpcConfig');
  }
  if (!disabledTls(revision.TlsConfig)) {
    mismatches.push('TlsConfig');
  }
  if (!disabledMount(revision.NasStorage, 'EnableNas', 'NasConfigs')) {
    mismatches.push('NasStorage');
  }
  if (!disabledMount(revision.TosMountConfig, 'EnableTos', 'MountPoints')) {
    mismatches.push('TosMountConfig');
  }
  if (mismatches.length > 0) {
    throw new PrivateSandboxConfigurationError(mismatches);
  }
}

function nestedBoolean(value: unknown, key: string): boolean | null {
  return isRecord(value) && typeof value[key] === 'boolean' ? value[key] : null;
}

function disabledVpc(value: unknown): boolean {
  return isRecord(value)
    && nestedBoolean(value, 'EnableVpc') === false
    && nestedBoolean(value, 'EnableSharedInternetAccess') === false
    && optionalEmptyString(value.VpcId)
    && optionalEmptyArray(value.SubnetIds)
    && optionalEmptyArray(value.SecurityGroupIds);
}

function disabledTls(value: unknown): boolean {
  return isRecord(value)
    && nestedBoolean(value, 'EnableLog') === false
    && optionalEmptyString(value.TlsProjectId)
    && optionalEmptyString(value.TlsTopicId);
}

function disabledMount(value: unknown, enableKey: string, pointsKey: string): boolean {
  return isRecord(value)
    && nestedBoolean(value, enableKey) === false
    && optionalEmptyArray(value[pointsKey]);
}

function optionalEmptyString(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function optionalEmptyArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTag(value: unknown, key: string, expectedValue: string): boolean {
  return Array.isArray(value) && value.some((entry) => isRecord(entry)
    && entry.Key === key
    && entry.Value === expectedValue);
}

function inventoryExcludes(
  inventory: Record<string, unknown>[],
  name: string,
  functionId: string,
): boolean {
  return !inventory.some((item) => item.Id === functionId || item.Name === name);
}

async function listAllFunctionItems(
  call: (
    action: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await call('ListFunctions', { PageNumber: pageNumber, PageSize: 100 });
    if (!Array.isArray(page.Items)
      || !page.Items.every(isRecord)
      || !Number.isInteger(page.Total)
      || (page.Total as number) < 0
      || (page.Total as number) > 10_000) {
      throw new Error('Private sandbox function inventory was invalid');
    }
    all.push(...page.Items);
    if (all.length >= (page.Total as number)) return all;
    if (page.Items.length === 0) {
      throw new Error('Private sandbox function inventory was incomplete');
    }
  }
  throw new Error('Private sandbox function inventory exceeded page bound');
}
