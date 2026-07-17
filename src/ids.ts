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
  | 'tnt'  // tenant
  | 'key'  // api key
  | 'cred'; // credential

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}
