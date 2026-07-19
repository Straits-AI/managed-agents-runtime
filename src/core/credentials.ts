/** Complete execution identity and policy request for one credential release. */
export interface CredentialReleaseRequest {
  tenantId: string;
  runId: string;
  attemptId: string;
  caller: string;
  purpose: string;
  action: string;
  resource: string;
  approvalId?: string | null;
  idempotencyKey: string;
}
