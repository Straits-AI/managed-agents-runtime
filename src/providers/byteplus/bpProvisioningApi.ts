import { boundedRequestId } from './signer.js';
import { executeBpCapture } from './privateWebshell.js';
import type {
  VefaasProvisioningApi,
  VefaasProvisioningResponse,
} from './sandboxApplication.js';

export function createBpProvisioningApi(input: {
  profile: string;
  region: string;
  executeBp?: (args: string[]) => Promise<string>;
}): VefaasProvisioningApi {
  for (const [name, value] of [
    ['profile', input.profile],
    ['region', input.region],
  ] as const) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
      throw new Error(`BytePlus provisioning ${name} is invalid`);
    }
  }
  const executeBp = input.executeBp ?? executeBpCapture;
  return async (action, body): Promise<VefaasProvisioningResponse> => {
    if (!/^[A-Z][A-Za-z0-9]{1,79}$/.test(action)) {
      throw new Error('BytePlus provisioning action is invalid');
    }
    const stdout = await executeBp([
      'vefaas',
      action,
      '--body',
      JSON.stringify(body),
      '---profile',
      input.profile,
      '---region',
      input.region,
    ]);
    if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) {
      throw new Error(`BytePlus provisioning ${action} response exceeded bound`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`BytePlus provisioning ${action} response was invalid`);
    }
    const envelope = parsed as {
      ResponseMetadata?: { RequestId?: unknown; Error?: unknown };
      Result?: unknown;
    };
    if (envelope.ResponseMetadata?.Error
      || typeof envelope.Result !== 'object'
      || envelope.Result === null
      || Array.isArray(envelope.Result)) {
      throw new Error(`BytePlus provisioning ${action} request failed`);
    }
    return {
      result: envelope.Result as Record<string, unknown>,
      requestId: boundedRequestId(envelope.ResponseMetadata?.RequestId),
    };
  };
}
