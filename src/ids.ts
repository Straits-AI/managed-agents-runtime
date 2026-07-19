import { ulid } from 'ulid';

export type IdPrefix =
  | 'ad'   // agent definition
  | 'av'   // agent version
  | 'run'
  | 'att'  // run attempt
  | 'ws'   // workspace
  | 'rev'  // workspace revision
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
