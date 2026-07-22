import { createHash } from 'node:crypto';
import {
  KertasRuntimeClient,
  RuntimeHttpError,
  selectCompatibleContract,
} from './index.js';

const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForRun(
  client: KertasRuntimeClient,
  runId: string,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    if (terminalStatuses.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`run ${runId} did not reach a terminal disposition`);
}

async function expectNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof RuntimeHttpError && error.status === 404) return;
    throw error;
  }
  throw new Error('cross-tenant resource was unexpectedly visible');
}

function assertMonotonic(values: Array<string | number>, label: string): void {
  const parsed = values.map((value) => BigInt(value));
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index]! <= parsed[index - 1]!) {
      throw new Error(`${label} is not strictly monotonic`);
    }
  }
}

async function main(): Promise<void> {
  const baseUrl = required('KERTAS_RUNTIME_URL');
  const tenantToken = required('KERTAS_TENANT_TOKEN');
  const otherTenantToken = required('KERTAS_OTHER_TENANT_TOKEN');
  const serverCommit = required('KERTAS_SERVER_COMMIT');
  const clientCommit = required('KERTAS_CLIENT_COMMIT');
  const imageDigest = required('KERTAS_IMAGE_DIGEST');
  const client = new KertasRuntimeClient({ baseUrl, bearerToken: tenantToken });
  const otherTenant = new KertasRuntimeClient({ baseUrl, bearerToken: otherTenantToken });

  const catalog = await client.getContractCatalog();
  const target = await client.discover();
  assert(target.mode === 'managed-session', 'live deployment did not select ManagedSession mode');
  const compatibility = selectCompatibleContract({
    ...catalog,
    contracts: catalog.contracts.filter((contract) => contract.id === 'run-as-session/v1'),
  });
  assert(compatibility.mode === 'compatibility', 'compatibility mode was not selectable');
  const targetDocument = await client.getContractDocument(target.contractId);
  const compatibilityDocument = await client.getContractDocument(compatibility.contractId);
  assert(targetDocument.id === target.contractId, 'target contract document did not match discovery');
  assert(
    typeof targetDocument.schemas === 'object' && targetDocument.schemas !== null,
    'target contract document did not publish schemas',
  );
  assert(
    compatibilityDocument.id === compatibility.contractId,
    'compatibility contract document did not match discovery',
  );

  const agent = await client.createAgent({ name: `kertas-conformance-${Date.now()}` });
  assert(typeof agent.id === 'string', 'agent create did not return an id');
  const version = await client.createAgentVersion(agent.id, {
    instructions: 'Execute the deterministic conformance script.',
    modelPolicy: {},
  });
  assert(typeof version.id === 'string', 'agent version create did not return an id');

  const initialScript = [
    {
      op: 'delegate',
      goals: ['inspect input snapshot', 'verify runtime contract'],
      childScript: [{ op: 'complete' }],
    },
    {
      op: 'complete',
      artifacts: [{
        path: 'conformance-result.json',
        content: '{"status":"verified","source":"kertas-public-contract"}\n',
      }],
    },
  ];
  const session = await client.createManagedSession({
    agentVersionId: version.id,
    objective: 'Prove the Kertas public runtime boundary.',
    correlationRef: 'kertas-project:conformance',
    start: {
      goal: 'Run the first managed execution.',
      input: { script: initialScript },
    },
  }, 'kertas-conformance-session-v1');
  assert(typeof session.currentTopLevelRunId === 'string', 'session did not start a Run');
  await expectNotFound(() => otherTenant.getManagedSession(session.id));

  const initialRun = await waitForRun(client, session.currentTopLevelRunId);
  assert(initialRun.status === 'COMPLETED', 'initial managed Run did not complete');
  await expectNotFound(() => otherTenant.getRun(session.currentTopLevelRunId as string));
  const runEvents = await client.listRunEvents(session.currentTopLevelRunId);
  assert(runEvents.events.length > 0, 'managed Run returned no resource events');
  assertMonotonic(runEvents.events.map((event) => event.seq), 'Run event sequence');
  const children = await client.getChildResults(session.currentTopLevelRunId);
  assert(children.children.length === 2, 'delegated child projection was incomplete');
  assert(children.selected.every((child) => child.status === 'COMPLETED'), 'child result failed');
  const artifacts = await client.listRunArtifacts(session.currentTopLevelRunId);
  assert(artifacts.artifacts.length === 1, 'artifact projection was incomplete');
  const artifact = artifacts.artifacts[0]!;
  assert(typeof artifact.id === 'string', 'artifact projection has no id');
  assert(typeof artifact.digest === 'string', 'artifact projection has no digest');
  const artifactContent = await client.getArtifactContent(
    session.currentTopLevelRunId,
    artifact.id,
  );
  const artifactDigest = `sha256:${createHash('sha256').update(artifactContent.bytes).digest('hex')}`;
  assert(artifactDigest === artifact.digest, 'artifact content did not match its published digest');
  assert(Number(artifact.sizeBytes) === artifactContent.bytes.byteLength, 'artifact size did not match');
  await expectNotFound(() => otherTenant.listManagedSessionEvents(session.id));
  await expectNotFound(() => otherTenant.listRunEvents(session.currentTopLevelRunId as string));
  await expectNotFound(() => otherTenant.getChildResults(session.currentTopLevelRunId as string));
  await expectNotFound(() => otherTenant.listRunArtifacts(session.currentTopLevelRunId as string));
  await expectNotFound(() => otherTenant.getArtifactContent(
    session.currentTopLevelRunId as string,
    artifact.id as string,
  ));

  const snapshotDigest = `sha256:${createHash('sha256')
    .update('immutable-kertas-conformance-snapshot-v1')
    .digest('hex')}`;
  const receipt = await client.deliverManagedSessionEvent(session.id, {
    apiVersion: 'kertas.runtime/v1alpha1',
    eventId: 'kertas-conformance-future-event-v1',
    type: 'kertas.feedback.received',
    occurredAt: new Date().toISOString(),
    sourceSequence: 1,
    subject: { type: 'project', ref: 'kertas-project:conformance' },
    data: { goal: 'Process the immutable feedback snapshot.' },
    inputSnapshotRefs: [{
      snapshotId: 'kertas-conformance-snapshot-v1',
      digest: snapshotDigest,
      sizeBytes: 40,
      formatVersion: 'kertas.workspace-snapshot/v1',
    }],
  });
  assert(receipt.status === 'PENDING', 'future event was not durably queued');
  const receiptSnapshots = receipt.inputSnapshotRefs as Array<Record<string, unknown>> | undefined;
  assert(receiptSnapshots?.[0]?.digest === snapshotDigest, 'event receipt lost snapshot digest');

  let events = await client.listManagedSessionEvents(session.id);
  const eventDeadline = Date.now() + 45_000;
  while (events.events[0]?.status !== 'DISPATCHED' && Date.now() < eventDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    events = await client.listManagedSessionEvents(session.id);
  }
  assert(events.events[0]?.status === 'DISPATCHED', 'future event was not dispatched');
  assertMonotonic(events.events.map((event) => event.receivedSequence), 'session receipt sequence');
  assert(typeof events.events[0].runId === 'string', 'dispatched receipt has no Run');
  const listedSnapshots = events.events[0].inputSnapshotRefs as
    Array<Record<string, unknown>> | undefined;
  assert(listedSnapshots?.[0]?.digest === snapshotDigest, 'event listing lost snapshot digest');
  const futureRun = await waitForRun(client, events.events[0].runId);
  assert(futureRun.status === 'COMPLETED', 'future-event Run did not complete');
  const futureInput = futureRun.input as Record<string, unknown> | undefined;
  const runSnapshots = futureInput?.inputSnapshotRefs as Array<Record<string, unknown>> | undefined;
  assert(runSnapshots?.[0]?.digest === snapshotDigest, 'dispatched Run lost snapshot digest');

  const compatibilityRun = await client.createCompatibilityRun({
    agentVersionId: version.id,
    goal: 'Exercise the supported run-as-session/v1 compatibility path.',
    input: { script: [{ op: 'complete' }] },
  });
  const compatibilityResult = await waitForRun(client, compatibilityRun.id);
  assert(compatibilityResult.status === 'COMPLETED', 'compatibility Run did not complete');
  const compatibilityEvents = await client.listRunEvents(compatibilityRun.id);
  assertMonotonic(compatibilityEvents.events.map((event) => event.seq), 'compatibility event sequence');

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'passed',
    endpoint: new URL(baseUrl).hostname,
    endpointIsLoopback: ['127.0.0.1', 'localhost', '::1'].includes(new URL(baseUrl).hostname),
    serverCommit,
    clientCommit,
    imageDigest,
    contracts: {
      discovered: catalog.contracts.map((contract) => contract.id),
      target: target.contractId,
      compatibility: compatibility.contractId,
      documentsValidated: [targetDocument.id, compatibilityDocument.id],
    },
    tenantIsolation:
      'cross-tenant session, events, Run, artifacts, artifact content, and child results returned 404',
    managedSession: {
      id: session.id,
      initialRunId: session.currentTopLevelRunId,
      futureRunId: events.events[0].runId,
      receivedSequences: events.events.map((event) => event.receivedSequence),
      childResultCount: children.children.length,
      artifactProjectionCount: artifacts.artifacts.length,
      artifactDigest,
      artifactContentVerified: true,
      snapshotDigest,
      executionDisposition: futureRun.status,
    },
    compatibilityRun: {
      id: compatibilityRun.id,
      executionDisposition: compatibilityResult.status,
    },
    kertasDecision: {
      outcomeSatisfied: null,
      releaseCreated: false,
      reason: 'runtime execution disposition is not a Kertas Outcome or Release decision',
    },
  })}\n`);
}

await main();
