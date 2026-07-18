import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('production configuration', () => {
  it('refuses to start without an explicit non-default API token', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'Unsafe production configuration: API_AUTH_TOKEN must be explicitly set',
    );

    expect(() =>
      loadConfig({ NODE_ENV: 'production', API_AUTH_TOKEN: 'dev-token' }),
    ).toThrow(
      'Unsafe production configuration: API_AUTH_TOKEN must be explicitly set',
    );

    expect(() =>
      loadConfig({ NODE_ENV: 'production', API_AUTH_TOKEN: 'too-short' }),
    ).toThrow(
      'Unsafe production configuration: API_AUTH_TOKEN must contain at least 32 non-whitespace characters',
    );

    expect(
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
      }).NODE_ENV,
    ).toBe('production');
  });

  it('binds the API to loopback unless an address is explicitly configured', () => {
    expect(loadConfig({}).API_HOST).toBe('127.0.0.1');
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(
      'Unsafe exposed API configuration: API_AUTH_TOKEN must contain at least 32 non-whitespace characters',
    );
    expect(
      loadConfig({
        API_HOST: '0.0.0.0',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
      }).API_HOST,
    ).toBe('0.0.0.0');
  });

  it('refuses to enable harness fault injection in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
        HARNESS_ENABLE_FAULTS: '1',
      }),
    ).toThrow(
      'Unsafe production configuration: HARNESS_ENABLE_FAULTS must be disabled',
    );

    expect(() =>
      loadConfig({
        API_HOST: '0.0.0.0',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
        HARNESS_ENABLE_FAULTS: '1',
      }),
    ).toThrow(
      'Unsafe exposed API configuration: HARNESS_ENABLE_FAULTS must be disabled',
    );
  });
});
