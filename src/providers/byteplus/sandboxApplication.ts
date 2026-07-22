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
}

export interface PrivateSandboxProvisioningReceipt {
  disposition: 'created' | 'reused';
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

const CODE_IMAGE =
  'enterprise-public-ap-southeast-1.cr.volces.com/vefaas-public/code-cli:0.0.7';

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
    maxConcurrency: 1,
    requestTimeoutSeconds: 900,
    initializerSeconds: 120,
  };
}

export async function provisionPrivateSandboxApplication(
  plan: PrivateSandboxApplicationPlan,
  api: VefaasProvisioningApi,
  dependencies: { sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<PrivateSandboxProvisioningReceipt> {
  const requestIds: Array<{ action: string; requestId: string | null }> = [];
  const call = async (action: string, body: Record<string, unknown>) => {
    const response = await api(action, body);
    requestIds.push({ action, requestId: response.requestId });
    return response.result;
  };

  const inventory = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
  const items = Array.isArray(inventory.Items) ? inventory.Items : [];
  const matches = items.filter((item) => isRecord(item) && item.Name === plan.name);
  if (matches.length > 1) {
    throw new Error('Multiple private sandbox applications matched the exact name');
  }
  if (matches.length === 1) {
    const functionId = boundedIdentifier(matches[0]?.Id);
    if (!functionId) throw new Error('Existing private sandbox application ID is invalid');
    const revision = await call('GetRevision', {
      FunctionId: functionId,
      RevisionNumber: 1,
    });
    assertRevisionMatches(plan, functionId, revision);
    const status = await call('GetReleaseStatus', { FunctionId: functionId });
    const stableRevisionNumber = positiveInteger(status.StableRevisionNumber);
    const releaseRecordId = boundedIdentifier(status.ReleaseRecordId);
    if (status.Status !== 'done' || stableRevisionNumber !== 1 || !releaseRecordId) {
      throw new Error('Existing private sandbox application is not stably released');
    }
    return {
      disposition: 'reused',
      functionId,
      stableRevisionNumber,
      releaseRecordId,
      requestIds,
    };
  }

  let created: Record<string, unknown>;
  try {
    created = await call('CreateFunction', createBody(plan));
  } catch (error) {
    const afterCreate = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
    const possible = Array.isArray(afterCreate.Items)
      ? afterCreate.Items.filter((item) => isRecord(item) && item.Name === plan.name)
      : [];
    if (possible.length === 1) {
      const possibleId = boundedIdentifier(possible[0]?.Id);
      if (!possibleId) {
        throw new Error('Ambiguous CreateFunction cleanup target was invalid');
      }
      await call('DeleteFunction', { Id: possibleId });
      const afterDelete = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
      if (!inventoryExcludes(afterDelete, plan.name, possibleId)) {
        throw new Error('Ambiguous CreateFunction cleanup was not verified');
      }
    } else if (possible.length > 1) {
      throw new Error('Ambiguous CreateFunction produced multiple exact-name resources');
    }
    throw error;
  }
  const functionId = boundedIdentifier(created.Id);
  if (!functionId) throw new Error('CreateFunction returned an invalid function ID');

  try {
    const draft = await call('GetRevision', { FunctionId: functionId, RevisionNumber: 0 });
    assertRevisionMatches(plan, functionId, draft);

    const released = await call('Release', {
      FunctionId: functionId,
      RevisionNumber: 0,
      Description: 'Initial private sandbox release',
      TargetTrafficWeight: 100,
      RollingStep: 100,
      MaxInstance: 1,
    });
    const initialReleaseRecordId = boundedIdentifier(released.ReleaseRecordId);

    const sleep = dependencies.sleep ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await call('GetReleaseStatus', { FunctionId: functionId });
      if (status.Status === 'done') {
        const stableRevisionNumber = positiveInteger(status.StableRevisionNumber);
        const releaseRecordId = boundedIdentifier(status.ReleaseRecordId)
          ?? initialReleaseRecordId;
        if (stableRevisionNumber !== 1 || !releaseRecordId) {
          throw new Error('Private sandbox release completion was incomplete');
        }
        return {
          disposition: 'created',
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
      const after = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
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

  const before = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
  const exact = Array.isArray(before.Items)
    ? before.Items.filter((item) => isRecord(item)
      && item.Id === target.functionId
      && item.Name === target.name)
    : [];
  if (exact.length !== 1) {
    throw new Error('Private sandbox cleanup target did not match exactly');
  }
  await call('DeleteFunction', { Id: target.functionId });
  const after = await call('ListFunctions', { PageNumber: 1, PageSize: 100 });
  if (!inventoryExcludes(after, target.name, target.functionId)) {
    throw new Error('Private sandbox application deletion was not verified');
  }
  return { functionId: target.functionId, absent: true, requestIds };
}

function createBody(plan: PrivateSandboxApplicationPlan): Record<string, unknown> {
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
): void {
  const expected: Array<[string, unknown]> = [
    ['Id', functionId],
    ['Name', plan.name],
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
  ];
  for (const [key, value] of expected) {
    if (revision[key] !== value) {
      throw new Error(`Private sandbox draft mismatch: ${key}`);
    }
  }
  if (revision.InstanceType !== '' && revision.InstanceType !== undefined) {
    throw new Error('Private sandbox draft mismatch: InstanceType');
  }
  if (nestedBoolean(revision.VpcConfig, 'EnableVpc') !== false
    || nestedBoolean(revision.VpcConfig, 'EnableSharedInternetAccess') !== false
    || nestedBoolean(revision.TlsConfig, 'EnableLog') !== false
    || nestedBoolean(revision.NasStorage, 'EnableNas') !== false
    || nestedBoolean(revision.TosMountConfig, 'EnableTos') !== false) {
    throw new Error('Private sandbox draft enabled a forbidden capability');
  }
}

function nestedBoolean(value: unknown, key: string): boolean | null {
  return isRecord(value) && typeof value[key] === 'boolean' ? value[key] : null;
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

function inventoryExcludes(
  inventory: Record<string, unknown>,
  name: string,
  functionId: string,
): boolean {
  return Array.isArray(inventory.Items)
    && !inventory.Items.some((item) => isRecord(item)
      && (item.Id === functionId || item.Name === name));
}
