import { describe, expect, it, vi } from 'vitest';
import {
  defaultPrivateSandboxApplicationPlan,
  deletePrivateSandboxApplication,
  provisionPrivateSandboxApplication,
  type VefaasProvisioningApi,
} from '../src/providers/byteplus/sandboxApplication.js';

describe('private sandbox application provisioner', () => {
  it('creates a CPU sandbox, verifies the draft, and releases revision one', async () => {
    const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
    const api: VefaasProvisioningApi = async (action, body) => {
      calls.push({ action, body });
      const response = (result: Record<string, unknown>) => ({
        result,
        requestId: `request-${action}`,
      });
      if (action === 'ListFunctions') return response({ Items: [], Total: 0 });
      if (action === 'CreateFunction') return response({ Id: 'function-1' });
      if (action === 'GetRevision') return response(matchingRevision());
      if (action === 'Release') return response({ ReleaseRecordId: 'release-1' });
      if (action === 'GetReleaseStatus') return response({
        FunctionId: 'function-1',
        Status: 'done',
        StableRevisionNumber: 1,
        ReleaseRecordId: 'release-1',
      });
      throw new Error(`unexpected action ${action}`);
    };

    const receipt = await provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
      { sleep: vi.fn(async () => {}) },
    );

    expect(receipt).toMatchObject({
      disposition: 'created',
      functionId: 'function-1',
      stableRevisionNumber: 1,
      releaseRecordId: 'release-1',
    });
    const create = calls.find((call) => call.action === 'CreateFunction');
    expect(create?.body).toMatchObject({
      Name: 'managed-agents-runtime-test',
      FunctionType: 'sandbox',
      Runtime: 'native/v1',
      SourceType: 'image',
      Command: '/opt/gem/run.sh',
      Port: 8080,
      CpuMilli: 1000,
      MemoryMB: 2048,
      RequestTimeout: 900,
      VpcConfig: { EnableVpc: false, EnableSharedInternetAccess: false },
      TlsConfig: { EnableLog: false },
      NasStorage: { EnableNas: false, NasConfigs: [] },
      TosMountConfig: { EnableTos: false, MountPoints: [] },
    });
    expect(create?.body).not.toHaveProperty('InstanceType');
    expect(calls.map((call) => call.action)).toEqual([
      'ListFunctions',
      'CreateFunction',
      'GetRevision',
      'Release',
      'GetReleaseStatus',
    ]);
  });

  it('reuses one exact released application without mutating it', async () => {
    const actions: string[] = [];
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      const result = action === 'ListFunctions'
        ? { Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }], Total: 1 }
        : action === 'GetRevision'
          ? matchingRevision()
          : action === 'GetReleaseStatus'
            ? {
                Status: 'done',
                StableRevisionNumber: 1,
                ReleaseRecordId: 'release-1',
              }
            : (() => { throw new Error(`unexpected mutation ${action}`); })();
      return { result, requestId: `request-${action}` };
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).resolves.toMatchObject({
      disposition: 'reused',
      functionId: 'function-1',
      stableRevisionNumber: 1,
      releaseRecordId: 'release-1',
    });
    expect(actions).toEqual(['ListFunctions', 'GetRevision', 'GetReleaseStatus']);
  });

  it('fails closed before mutation when an exact-name application differs', async () => {
    const actions: string[] = [];
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListFunctions') return {
        result: {
          Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }],
          Total: 1,
        },
        requestId: 'request-list',
      };
      if (action === 'GetRevision') return {
        result: { ...matchingRevision(), InstanceType: 'nvidia-tesla-l4' },
        requestId: 'request-revision',
      };
      throw new Error(`unexpected mutation ${action}`);
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).rejects.toThrow('InstanceType');
    expect(actions).toEqual(['ListFunctions', 'GetRevision']);
  });

  it('deletes only its newly created function when draft verification fails', async () => {
    const actions: string[] = [];
    let inventoryCount = 0;
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListFunctions') {
        inventoryCount += 1;
        return {
          result: inventoryCount === 1
            ? { Items: [], Total: 0 }
            : { Items: [], Total: 0 },
          requestId: `request-list-${inventoryCount}`,
        };
      }
      if (action === 'CreateFunction') return {
        result: { Id: 'function-created-by-run' },
        requestId: 'request-create',
      };
      if (action === 'GetRevision') return {
        result: { ...matchingRevision(), Id: 'function-created-by-run', Port: 9000 },
        requestId: 'request-revision',
      };
      if (action === 'DeleteFunction') {
        return { result: {}, requestId: 'request-delete' };
      }
      throw new Error(`unexpected action ${action}`);
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).rejects.toThrow('Port');
    expect(actions).toEqual([
      'ListFunctions',
      'CreateFunction',
      'GetRevision',
      'DeleteFunction',
      'ListFunctions',
    ]);
  });

  it('inventories and removes one exact new function after an ambiguous create error', async () => {
    const actions: string[] = [];
    let listed = 0;
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListFunctions') {
        listed += 1;
        const present = listed === 2;
        return {
          result: {
            Items: present
              ? [{ Id: 'function-ambiguous', Name: 'managed-agents-runtime-test' }]
              : [],
            Total: present ? 1 : 0,
          },
          requestId: `request-list-${listed}`,
        };
      }
      if (action === 'CreateFunction') throw new Error('connection closed');
      if (action === 'DeleteFunction') return {
        result: {},
        requestId: 'request-delete',
      };
      throw new Error(`unexpected action ${action}`);
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).rejects.toThrow('connection closed');
    expect(actions).toEqual([
      'ListFunctions',
      'CreateFunction',
      'ListFunctions',
      'DeleteFunction',
      'ListFunctions',
    ]);
  });

  it('deletes an exact idle application and verifies fresh absence', async () => {
    const actions: string[] = [];
    let functionsListed = 0;
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListSandboxes') return {
        result: { Sandboxes: [], Total: 0 },
        requestId: 'request-sandboxes',
      };
      if (action === 'ListFunctions') {
        functionsListed += 1;
        return {
          result: {
            Items: functionsListed === 1
              ? [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }]
              : [],
            Total: functionsListed === 1 ? 1 : 0,
          },
          requestId: `request-functions-${functionsListed}`,
        };
      }
      if (action === 'DeleteFunction') return {
        result: {},
        requestId: 'request-delete',
      };
      throw new Error(`unexpected action ${action}`);
    };

    await expect(deletePrivateSandboxApplication({
      functionId: 'function-1',
      name: 'managed-agents-runtime-test',
    }, api)).resolves.toMatchObject({
      functionId: 'function-1',
      absent: true,
    });
    expect(actions).toEqual([
      'ListSandboxes',
      'ListFunctions',
      'DeleteFunction',
      'ListFunctions',
    ]);
  });
});

function matchingRevision(): Record<string, unknown> {
  return {
    Id: 'function-1',
    Name: 'managed-agents-runtime-test',
    FunctionType: 'sandbox',
    Runtime: 'native/v1',
    SourceType: 'image',
    Source: 'enterprise-public-ap-southeast-1.cr.volces.com/vefaas-public/code-cli:0.0.7',
    Command: '/opt/gem/run.sh',
    Port: 8080,
    CpuStrategy: 'always',
    CpuMilli: 1000,
    MemoryMB: 2048,
    MaxConcurrency: 1,
    RequestTimeout: 900,
    InstanceType: '',
    VpcConfig: { EnableVpc: false, EnableSharedInternetAccess: false },
    TlsConfig: { EnableLog: false },
    NasStorage: { EnableNas: false, NasConfigs: [] },
    TosMountConfig: { EnableTos: false, MountPoints: [] },
  };
}
