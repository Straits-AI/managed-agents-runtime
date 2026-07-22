import { ulid } from 'ulid';

export type IdPrefix =
  | 'ad'   // agent definition
  | 'av'   // agent version
  | 'run'
  | 'ses'  // managed session
  | 'scmd' // managed-session command receipt
  | 'att'  // run attempt
  | 'ws'   // workspace
  | 'rev'  // workspace revision
  | 'art'  // immutable runtime artifact
  | 'ckpt' // checkpoint
  | 'rcpt' // tool receipt
  | 'apr'  // approval
  | 'cap'  // capability grant
  | 'mem'  // agent memory
  | 'kdoc' // knowledge document
  | 'kbnd' // tenant-owned knowledge binding
  | 'tnt'  // tenant
  | 'key'  // api key
  | 'cred' // credential
  | 'cgr'  // credential grant
  | 'cuse'; // credential use receipt

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}
