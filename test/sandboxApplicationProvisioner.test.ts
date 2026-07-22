import { describe, expect, it, vi } from 'vitest';
import {
  defaultPrivateSandboxApplicationPlan,
  deletePrivateSandboxApplication,
  PrivateSandboxConfigurationError,
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
      if (action === 'GetFunction') return response(matchingRevision(0));
      if (action === 'GetRevision') return response(
        matchingRevision(Number(body.RevisionNumber)),
      );
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
      { sleep: vi.fn(async () => {}), attemptId: 'attempt-fixture' },
    );

    expect(receipt).toMatchObject({
      disposition: 'created',
      attemptId: 'attempt-fixture',
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
      Command: 'bash /root/sandbox/scripts/run.sh',
      Port: 8080,
      CpuMilli: 1000,
      MemoryMB: 2048,
      MaxConcurrency: 10,
      RequestTimeout: 900,
      Envs: [{ Key: 'HOME', Value: '/home/tiger' }],
      VpcConfig: { EnableVpc: false, EnableSharedInternetAccess: false },
      TlsConfig: { EnableLog: false },
      NasStorage: { EnableNas: false, NasConfigs: [] },
      TosMountConfig: { EnableTos: false, MountPoints: [] },
      Tags: [
        { Key: 'managed-by', Value: 'managed-agents-runtime' },
        { Key: 'managed-purpose', Value: 'private-sandbox' },
        { Key: 'provisioning-attempt', Value: 'attempt-fixture' },
      ],
    });
    expect(create?.body).not.toHaveProperty('InstanceType');
    expect(calls.map((call) => call.action)).toEqual([
      'ListFunctions',
      'CreateFunction',
      'GetFunction',
      'GetRevision',
      'Release',
      'GetReleaseStatus',
      'GetRevision',
    ]);
  });

  it('reuses one exact released application without mutating it', async () => {
    const actions: string[] = [];
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      const result = action === 'ListFunctions'
        ? { Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }], Total: 1 }
        : action === 'GetFunction'
          ? matchingRevision(1)
        : action === 'GetRevision'
          ? matchingRevision(1)
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
    expect(actions).toEqual([
      'ListFunctions',
      'GetReleaseStatus',
      'GetFunction',
      'GetRevision',
    ]);
  });

  it('checks every reported inventory page before deciding to create', async () => {
    const actions: Array<{ action: string; body: Record<string, unknown> }> = [];
    const api: VefaasProvisioningApi = async (action, body) => {
      actions.push({ action, body });
      if (action === 'ListFunctions') {
        const page = body.PageNumber;
        return {
          result: page === 1
            ? {
                Items: Array.from({ length: 100 }, (_, index) => ({
                  Id: `other-${index}`,
                  Name: `other-${index}`,
                })),
                Total: 101,
              }
            : {
                Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }],
                Total: 101,
              },
          requestId: `request-list-${page}`,
        };
      }
      if (action === 'GetRevision') return {
        result: matchingRevision(1),
        requestId: 'request-revision',
      };
      if (action === 'GetFunction') return {
        result: matchingRevision(1),
        requestId: 'request-function',
      };
      if (action === 'GetReleaseStatus') return {
        result: {
          Status: 'done',
          StableRevisionNumber: 1,
          ReleaseRecordId: 'release-1',
        },
        requestId: 'request-release-status',
      };
      throw new Error(`unexpected mutation ${action}`);
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).resolves.toMatchObject({ disposition: 'reused', functionId: 'function-1' });
    expect(actions.slice(0, 2)).toEqual([
      { action: 'ListFunctions', body: { PageNumber: 1, PageSize: 100 } },
      { action: 'ListFunctions', body: { PageNumber: 2, PageSize: 100 } },
    ]);
    expect(actions.some(({ action }) => action === 'CreateFunction')).toBe(false);
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
        result: { ...matchingRevision(1), InstanceType: 'nvidia-tesla-l4' },
        requestId: 'request-revision',
      };
      if (action === 'GetFunction') return {
        result: matchingRevision(1),
        requestId: 'request-function',
      };
      if (action === 'GetReleaseStatus') return {
        result: {
          Status: 'done',
          StableRevisionNumber: 1,
          ReleaseRecordId: 'release-1',
        },
        requestId: 'request-release-status',
      };
      throw new Error(`unexpected mutation ${action}`);
    };

    try {
      await provisionPrivateSandboxApplication(
        defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
        api,
      );
      expect.unreachable('configuration drift should fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateSandboxConfigurationError);
      expect((error as PrivateSandboxConfigurationError).fields).toEqual(['InstanceType']);
    }
    expect(actions).toEqual([
      'ListFunctions',
      'GetReleaseStatus',
      'GetFunction',
      'GetRevision',
    ]);
  });

  it.each([
    ['description', { Description: 'unexpected description' }],
    ['initializer', { InitializerSec: 60 }],
    ['CPU allocation', { CpuMilli: 2000 }],
    ['environment variables', { Envs: [{ Key: 'unexpected', Value: 'value' }] }],
    ['enabled VPC', {
      VpcConfig: {
        EnableVpc: true,
        EnableSharedInternetAccess: false,
        VpcId: '',
        SubnetIds: [],
        SecurityGroupIds: [],
      },
    }],
    ['shared internet VPC', {
      VpcConfig: {
        EnableVpc: false,
        EnableSharedInternetAccess: true,
        VpcId: '',
        SubnetIds: [],
        SecurityGroupIds: [],
      },
    }],
    ['VPC identifiers', {
      VpcConfig: {
        EnableVpc: false,
        EnableSharedInternetAccess: false,
        VpcId: 'vpc-unexpected',
        SubnetIds: [],
        SecurityGroupIds: [],
      },
    }],
    ['TLS identifiers', {
      TlsConfig: {
        EnableLog: false,
        TlsProjectId: 'project-unexpected',
        TlsTopicId: '',
      },
    }],
    ['NAS mounts', { NasStorage: { EnableNas: false, NasConfigs: [{}] } }],
    ['TOS mounts', { TosMountConfig: { EnableTos: false, MountPoints: [{}] } }],
  ])('rejects an existing application with mismatched %s', async (_case, patch) => {
    const api: VefaasProvisioningApi = async (action) => ({
      result: action === 'ListFunctions'
        ? { Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }], Total: 1 }
        : action === 'GetReleaseStatus'
          ? {
              Status: 'done',
              StableRevisionNumber: 1,
              ReleaseRecordId: 'release-1',
            }
        : action === 'GetFunction'
          ? matchingRevision(1)
        : action === 'GetRevision'
          ? { ...matchingRevision(1), ...patch }
          : (() => { throw new Error(`unexpected action ${action}`); })(),
      requestId: `request-${action}`,
    });

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).rejects.toThrow('mismatch');
  });

  it('accepts provider-canonical omission of default CPU, empty envs, and disabled VPC', async () => {
    const readback = { ...matchingRevision(1) };
    delete readback.CpuMilli;
    delete readback.Envs;
    delete readback.VpcConfig;
    const api: VefaasProvisioningApi = async (action) => ({
      result: action === 'ListFunctions'
        ? { Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }], Total: 1 }
        : action === 'GetReleaseStatus'
          ? {
              Status: 'done',
              StableRevisionNumber: 1,
              ReleaseRecordId: 'release-1',
            }
          : action === 'GetFunction' || action === 'GetRevision'
            ? readback
            : (() => { throw new Error(`unexpected action ${action}`); })(),
      requestId: `request-${action}`,
    });

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).resolves.toMatchObject({ disposition: 'reused', functionId: 'function-1' });
  });

  it('accepts omitted false booleans in a provider-canonical disabled VPC object', async () => {
    const readback = {
      ...matchingRevision(1),
      VpcConfig: { VpcId: '', SubnetIds: [], SecurityGroupIds: [] },
    };
    const api: VefaasProvisioningApi = async (action) => ({
      result: action === 'ListFunctions'
        ? { Items: [{ Id: 'function-1', Name: 'managed-agents-runtime-test' }], Total: 1 }
        : action === 'GetReleaseStatus'
          ? {
              Status: 'done',
              StableRevisionNumber: 1,
              ReleaseRecordId: 'release-1',
            }
          : action === 'GetFunction' || action === 'GetRevision'
            ? readback
            : (() => { throw new Error(`unexpected action ${action}`); })(),
      requestId: `request-${action}`,
    });

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
    )).resolves.toMatchObject({ disposition: 'reused', functionId: 'function-1' });
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
      if (action === 'GetFunction') return {
        result: { ...matchingRevision(0), Id: 'function-created-by-run' },
        requestId: 'request-function',
      };
      if (action === 'GetRevision') return {
        result: { ...matchingRevision(0), Id: 'function-created-by-run', Port: 9000 },
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
      'GetFunction',
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
              ? [{
                  Id: 'function-ambiguous',
                  Name: 'managed-agents-runtime-test',
                  Tags: [{ Key: 'provisioning-attempt', Value: 'attempt-fixture' }],
                }]
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
      { attemptId: 'attempt-fixture' },
    )).rejects.toThrow('connection closed');
    expect(actions).toEqual([
      'ListFunctions',
      'CreateFunction',
      'ListFunctions',
      'DeleteFunction',
      'ListFunctions',
    ]);
  });

  it('retries bounded inventory lookup before cleaning up an eventually visible create', async () => {
    const actions: string[] = [];
    let listed = 0;
    const sleep = vi.fn(async () => {});
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListFunctions') {
        listed += 1;
        const present = listed === 4;
        return {
          result: {
            Items: present
              ? [{
                  Id: 'function-eventually-visible',
                  Name: 'managed-agents-runtime-test',
                  Tags: [{ Key: 'provisioning-attempt', Value: 'attempt-fixture' }],
                }]
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
      {
        attemptId: 'attempt-fixture',
        ambiguousCreateInventoryAttempts: 4,
        sleep,
      },
    )).rejects.toThrow('connection closed');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(actions).toEqual([
      'ListFunctions',
      'CreateFunction',
      'ListFunctions',
      'ListFunctions',
      'ListFunctions',
      'DeleteFunction',
      'ListFunctions',
    ]);
  });

  it('does not delete an ambiguous exact-name function without the attempt tag', async () => {
    const actions: string[] = [];
    let listed = 0;
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListFunctions') {
        listed += 1;
        return {
          result: {
            Items: listed === 1
              ? []
              : [{ Id: 'function-unowned', Name: 'managed-agents-runtime-test' }],
            Total: listed === 1 ? 0 : 1,
          },
          requestId: `request-list-${listed}`,
        };
      }
      if (action === 'CreateFunction') throw new Error('connection closed');
      throw new Error(`unexpected destructive action ${action}`);
    };

    await expect(provisionPrivateSandboxApplication(
      defaultPrivateSandboxApplicationPlan('managed-agents-runtime-test'),
      api,
      { attemptId: 'attempt-fixture' },
    )).rejects.toThrow('not proven disposable');
    expect(actions).toEqual(['ListFunctions', 'CreateFunction', 'ListFunctions']);
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
              ? [{
                  Id: 'function-1',
                  Name: 'managed-agents-runtime-test',
                  Tags: [
                    { Key: 'managed-by', Value: 'managed-agents-runtime' },
                    { Key: 'managed-purpose', Value: 'private-sandbox' },
                  ],
                }]
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

  it('deletes an exact application whose only residual child is terminating', async () => {
    const actions: string[] = [];
    let functionsListed = 0;
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListSandboxes') return {
        result: {
          Sandboxes: [{
            FunctionId: 'function-1',
            Id: 'sandbox-1',
            Status: 'Terminating',
          }],
          Total: 1,
        },
        requestId: 'request-sandboxes',
      };
      if (action === 'ListFunctions') {
        functionsListed += 1;
        return {
          result: {
            Items: functionsListed === 1
              ? [{
                  Id: 'function-1',
                  Name: 'managed-agents-runtime-test',
                  Tags: [
                    { Key: 'managed-by', Value: 'managed-agents-runtime' },
                    { Key: 'managed-purpose', Value: 'private-sandbox' },
                  ],
                }]
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

  it.each([
    ['Ready', 'function-1'],
    ['Pending', 'function-1'],
    ['Paused', 'function-1'],
    ['Terminating', 'function-other'],
    ['unknown', 'function-1'],
  ])('refuses cleanup for a %s residual child of %s', async (status, functionId) => {
    const actions: string[] = [];
    const api: VefaasProvisioningApi = async (action) => {
      actions.push(action);
      if (action === 'ListSandboxes') return {
        result: {
          Sandboxes: [{ FunctionId: functionId, Id: 'sandbox-1', Status: status }],
          Total: 1,
        },
        requestId: 'request-sandboxes',
      };
      throw new Error(`unexpected destructive action ${action}`);
    };

    await expect(deletePrivateSandboxApplication({
      functionId: 'function-1',
      name: 'managed-agents-runtime-test',
    }, api)).rejects.toThrow('still has active or unowned instances');
    expect(actions).toEqual(['ListSandboxes']);
  });
});

function matchingRevision(revisionNumber: number): Record<string, unknown> {
  return {
    Id: 'function-1',
    Name: 'managed-agents-runtime-test',
    FunctionType: 'sandbox',
    Runtime: 'native/v1',
    SourceType: 'image',
    Source: 'vefaas-ap-southeast-1.cr.volces.com/vefaas-public/sandbox-fusion:vefaas-latest',
    Command: 'bash /root/sandbox/scripts/run.sh',
    Port: 8080,
    CpuStrategy: 'always',
    CpuMilli: 1000,
    MemoryMB: 2048,
    MaxConcurrency: 10,
    Description: 'Private BytePlus runtime conformance application',
    RequestTimeout: 900,
    InitializerSec: 120,
    ExclusiveMode: false,
    ProjectName: 'default',
    Envs: [{ Key: 'HOME', Value: '/home/tiger' }],
    Tags: [
      { Key: 'managed-by', Value: 'managed-agents-runtime' },
      { Key: 'managed-purpose', Value: 'private-sandbox' },
    ],
    InstanceType: '',
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
    RevisionNumber: revisionNumber,
  };
}
