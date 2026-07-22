export interface ModelArkTemporaryKey {
  apiKey: string;
  requestId: string | null;
  expiresAt: Date;
}

export type ModelArkKeyResourceType = 'endpoint' | 'bot' | 'presetendpoint';

export interface ModelArkTemporaryKeyRequestInput {
  durationSeconds: number;
  resourceType: ModelArkKeyResourceType;
  resourceIds: string[];
  projectName?: string;
}

export interface ModelArkTemporaryKeyRequest {
  DurationSeconds: number;
  ResourceType: ModelArkKeyResourceType;
  ResourceIds: string[];
  ProjectName?: string;
}

export interface ModelArkKeyResourceBindingInput {
  resourceType: ModelArkKeyResourceType;
  model: string;
  keyResourceId: string;
  negativeModel: string;
  negativeKeyResourceId: string;
}

export function resolveModelArkKeyResourceBindings(
  input: ModelArkKeyResourceBindingInput,
): { positiveResourceId: string; negativeResourceId: string } {
  for (const value of [
    input.model,
    input.keyResourceId,
    input.negativeModel,
    input.negativeKeyResourceId,
  ]) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
      throw new Error('ModelArk key resource binding is invalid');
    }
  }
  if (input.resourceType === 'presetendpoint') {
    if (input.keyResourceId !== input.model) {
      throw new Error('ModelArk preset endpoint key resource must match the invoked model');
    }
    if (input.negativeKeyResourceId !== input.negativeModel) {
      throw new Error(
        'ModelArk preset endpoint negative key resource must match the invoked model',
      );
    }
  }
  return {
    positiveResourceId: input.keyResourceId,
    negativeResourceId: input.negativeKeyResourceId,
  };
}

export function createModelArkTemporaryKeyRequest(
  input: ModelArkTemporaryKeyRequestInput,
): ModelArkTemporaryKeyRequest {
  if (!['endpoint', 'bot', 'presetendpoint'].includes(input.resourceType)) {
    throw new Error('ModelArk temporary key resource type is invalid');
  }
  if (!Number.isSafeInteger(input.durationSeconds)
    || input.durationSeconds < 1
    || input.durationSeconds > 2_592_000) {
    throw new Error('ModelArk temporary key duration is invalid');
  }
  if (input.resourceIds.length === 0
    || input.resourceIds.some((id) => !/^[A-Za-z0-9._:-]{1,160}$/.test(id))) {
    throw new Error('ModelArk temporary key resource identifier is invalid');
  }
  if (input.resourceType === 'presetendpoint') {
    if (!input.projectName || !/^[A-Za-z0-9._-]{1,128}$/.test(input.projectName)) {
      throw new Error('ModelArk preset endpoint key requires an explicit project name');
    }
    return {
      DurationSeconds: input.durationSeconds,
      ResourceType: input.resourceType,
      ResourceIds: [...input.resourceIds],
      ProjectName: input.projectName,
    };
  }
  return {
    DurationSeconds: input.durationSeconds,
    ResourceType: input.resourceType,
    ResourceIds: [...input.resourceIds],
  };
}

export interface ModelArkInvocationResult {
  markerMatched: boolean;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  output: string;
}

export interface ModelArkConformanceDependencies {
  getTemporaryKey(input: { model: string }): Promise<ModelArkTemporaryKey>;
  invoke(input: { apiKey: string; model: string }): Promise<ModelArkInvocationResult>;
}

export interface BoundedProviderFailure {
  status: number | null;
  code: string | null;
  requestId: string | null;
}

export function parseBoundedProviderFailure(value: unknown): BoundedProviderFailure {
  const text = typeof value === 'string'
    ? value
    : value instanceof Uint8Array
      ? new TextDecoder().decode(value)
      : '';
  const statusMatch = /status code:\s*(\d{3})/i.exec(text);
  const codeMatch = /^([A-Za-z0-9._:-]{1,160}):/m.exec(text);
  const requestMatch = /request id:\s*([A-Za-z0-9._:-]{1,160})/i.exec(text);
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    code: codeMatch?.[1] ?? null,
    requestId: requestMatch?.[1] ?? null,
  };
}

export interface ModelArkConformanceEvidence {
  schemaVersion: 1;
  model: string;
  temporaryKey: {
    persisted: false;
    serialized: false;
    requestId: string | null;
    expiresAt: string;
  };
  inference: {
    markerMatched: true;
    requestId: string | null;
    inputTokens: number;
    outputTokens: number;
    finishReason: string;
  };
  redaction: {
    promptIncluded: false;
    outputIncluded: false;
    credentialIncluded: false;
  };
}

export async function runModelArkConformance(
  dependencies: ModelArkConformanceDependencies,
  options: { model: string; now?: Date },
): Promise<ModelArkConformanceEvidence> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(options.model)) {
    throw new Error('ModelArk conformance model identifier is invalid');
  }
  try {
    const temporaryKey = await dependencies.getTemporaryKey({ model: options.model });
    const now = options.now ?? new Date();
    if (!temporaryKey.apiKey || temporaryKey.expiresAt.getTime() <= now.getTime()) {
      throw new Error('ModelArk temporary key is absent or expired');
    }
    const result = await dependencies.invoke({
      apiKey: temporaryKey.apiKey,
      model: options.model,
    });
    if (!result.markerMatched) {
      throw new Error('ModelArk conformance marker was not returned');
    }
    return {
      schemaVersion: 1,
      model: options.model,
      temporaryKey: {
        persisted: false,
        serialized: false,
        requestId: safeToken(temporaryKey.requestId),
        expiresAt: temporaryKey.expiresAt.toISOString(),
      },
      inference: {
        markerMatched: true,
        requestId: safeToken(result.requestId),
        inputTokens: boundedCount(result.inputTokens),
        outputTokens: boundedCount(result.outputTokens),
        finishReason: safeToken(result.finishReason) ?? 'unknown',
      },
      redaction: {
        promptIncluded: false,
        outputIncluded: false,
        credentialIncluded: false,
      },
    };
  } catch (error) {
    throw sanitizedModelArkFailure(error);
  }
}

export interface ModelArkExpectedFailureEvidence {
  model: string;
  expectedCode: string;
  observed: true;
  status: number | null;
  code: string;
  requestId: string | null;
  temporaryKey: {
    persisted: false;
    serialized: false;
    requestId: string | null;
  };
  redaction: {
    promptIncluded: false;
    outputIncluded: false;
    credentialIncluded: false;
  };
}

export async function runModelArkExpectedFailure(
  dependencies: ModelArkConformanceDependencies,
  options: { model: string; expectedCode: string; now?: Date },
): Promise<ModelArkExpectedFailureEvidence> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(options.model)
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(options.expectedCode)) {
    throw new Error('ModelArk negative-probe configuration is invalid');
  }
  let temporaryKey: ModelArkTemporaryKey;
  try {
    temporaryKey = await dependencies.getTemporaryKey({ model: options.model });
    const now = options.now ?? new Date();
    if (!temporaryKey.apiKey || temporaryKey.expiresAt.getTime() <= now.getTime()) {
      throw new Error('ModelArk temporary key is absent or expired');
    }
  } catch (error) {
    throw sanitizedModelArkFailure(error);
  }

  try {
    await dependencies.invoke({ apiKey: temporaryKey.apiKey, model: options.model });
  } catch (error) {
    const failure = boundedFailureFromError(error);
    if (failure.code !== options.expectedCode) {
      throw sanitizedModelArkFailure(error);
    }
    return {
      model: options.model,
      expectedCode: options.expectedCode,
      observed: true,
      status: failure.status,
      code: options.expectedCode,
      requestId: failure.requestId,
      temporaryKey: {
        persisted: false,
        serialized: false,
        requestId: safeToken(temporaryKey.requestId),
      },
      redaction: {
        promptIncluded: false,
        outputIncluded: false,
        credentialIncluded: false,
      },
    };
  }
  throw new Error('ModelArk negative probe unexpectedly succeeded');
}

function safeToken(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
    ? value
    : null;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizedModelArkFailure(error: unknown): Error {
  const { status, code, requestId } = boundedFailureFromError(error);
  if (status !== null || code !== null || requestId !== null) {
    return new Error(
      `ModelArk conformance failed (HTTP ${status ?? 'unknown'}, ${code ?? 'Unknown'}, request ${requestId ?? 'unknown'})`,
    );
  }
  return new Error('ModelArk conformance failed');
}

function boundedFailureFromError(error: unknown): BoundedProviderFailure {
  if (typeof error !== 'object' || error === null) {
    return { status: null, code: null, requestId: null };
  }
  return {
    status: 'status' in error && typeof error.status === 'number' ? error.status : null,
    code: 'code' in error ? safeToken(error.code) : null,
    requestId: 'requestId' in error ? safeToken(error.requestId) : null,
  };
}
