import { TosClient } from '@volcengine/tos-sdk';
import type { Config } from '../config.js';
import { requireConfig } from '../config.js';
import type { ObjectStore } from './types.js';

/** TOS-backed object store for workspace snapshots, transcripts, artifacts. */
export class TosObjectStore implements ObjectStore {
  private readonly client: TosClient;
  private readonly bucket: string;

  constructor(cfg: Config) {
    const required = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'TOS_BUCKET',
    ]);
    this.client = new TosClient({
      accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
      accessKeySecret: required.BYTEPLUS_SECRET_ACCESS_KEY,
      stsToken: cfg.BYTEPLUS_SESSION_TOKEN,
      region: cfg.TOS_REGION,
      endpoint: cfg.TOS_ENDPOINT,
    });
    this.bucket = required.TOS_BUCKET;
  }

  async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    const res = await this.client.putObject({ bucket: this.bucket, key, body });
    return { etag: res.headers?.etag ?? null };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.getObjectV2({
      bucket: this.bucket,
      key,
      dataType: 'buffer',
    });
    return res.data.content as Buffer;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.headObject({ bucket: this.bucket, key });
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  async presignPut(key: string, ttlSec: number): Promise<string> {
    return this.client.getPreSignedUrl({
      bucket: this.bucket,
      key,
      method: 'PUT',
      expires: ttlSec,
    });
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    return this.client.getPreSignedUrl({
      bucket: this.bucket,
      key,
      method: 'GET',
      expires: ttlSec,
    });
  }
}
