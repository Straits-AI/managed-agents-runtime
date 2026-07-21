import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadKnowledgeAdminConfig } from '../src/bin/knowledgeAdmin.js';

describe('production configuration', () => {
  const secureEgress = {
    HTTP_EGRESS_MODE: 'allowlist',
    HTTP_EGRESS_ALLOWLIST: 'https://api.example.com',
  } as const;

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

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_TOKEN: `a${' '.repeat(30)}b`,
      }),
    ).toThrow(
      'Unsafe production configuration: API_AUTH_TOKEN must contain at least 32 non-whitespace characters',
    );

    expect(
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
        ...secureEgress,
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
        ...secureEgress,
      }).API_HOST,
    ).toBe('0.0.0.0');
  });

  it('refuses to enable harness fault injection in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
        ...secureEgress,
        HARNESS_ENABLE_FAULTS: '1',
      }),
    ).toThrow(
      'Unsafe production configuration: HARNESS_ENABLE_FAULTS must be disabled',
    );

    expect(() =>
      loadConfig({
        API_HOST: '0.0.0.0',
        API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
        ...secureEgress,
        HARNESS_ENABLE_FAULTS: '1',
      }),
    ).toThrow(
      'Unsafe exposed API configuration: HARNESS_ENABLE_FAULTS must be disabled',
    );
  });

  it('keeps AgentKit Knowledge disabled in shared deployments until live verification', () => {
    const shared = {
      NODE_ENV: 'production',
      API_AUTH_TOKEN: 'k'.repeat(32),
      KNOWLEDGE_PROVIDER: 'agentkit',
      ...secureEgress,
    };
    expect(() => loadConfig(shared)).toThrow(/AgentKit Knowledge.*live.*verified/i);
    expect(
      loadConfig({ ...shared, AGENTKIT_KNOWLEDGE_LIVE_VERIFIED: '1' })
        .KNOWLEDGE_PROVIDER,
    ).toBe('agentkit');
    expect(() =>
      loadConfig({
        API_HOST: '0.0.0.0',
        API_AUTH_TOKEN: 'k'.repeat(32),
        KNOWLEDGE_PROVIDER: 'agentkit',
        ...secureEgress,
      }),
    ).toThrow(/AgentKit Knowledge.*live.*verified/i);
  });

  it('allows only the operator knowledge command to bootstrap the live verification gate', () => {
    const shared = {
      NODE_ENV: 'production',
      API_AUTH_TOKEN: 'k'.repeat(32),
      KNOWLEDGE_PROVIDER: 'agentkit',
      ...secureEgress,
    };
    expect(() => loadConfig(shared)).toThrow(/AgentKit Knowledge.*live.*verified/i);
    const admin = loadKnowledgeAdminConfig(shared);
    expect(admin.NODE_ENV).toBe('production');
    expect(admin.KNOWLEDGE_PROVIDER).toBe('none');
  });

  it('requires an allowlist or controlled egress proxy for shared deployments', () => {
    const shared = {
      NODE_ENV: 'production',
      API_AUTH_TOKEN: 'k'.repeat(32),
    };
    expect(() => loadConfig(shared)).toThrow(/outbound HTTP.*allowlist.*proxy/i);
    expect(() => loadConfig({
      ...shared,
      HTTP_EGRESS_MODE: 'allowlist',
      HTTP_EGRESS_ALLOWLIST: '',
    })).toThrow(/allowlist.*origin/i);
    expect(() => loadConfig({
      ...shared,
      HTTP_EGRESS_MODE: 'proxy',
    })).toThrow(/proxy URL/i);
    expect(loadConfig({
      ...shared,
      HTTP_EGRESS_MODE: 'proxy',
      HTTP_EGRESS_PROXY_URL: 'https://egress-proxy.example.com/v1/forward',
    }).HTTP_EGRESS_MODE).toBe('proxy');
    expect(() => loadConfig({
      ...shared,
      HTTP_EGRESS_MODE: 'proxy',
      HTTP_EGRESS_PROXY_URL: 'http://egress-proxy.example.com/v1/forward',
    })).toThrow(/HTTPS.*proxy|proxy.*HTTPS/i);
    expect(loadConfig({
      ...shared,
      HTTP_EGRESS_MODE: 'proxy',
      HTTP_EGRESS_PROXY_URL: 'http://127.0.0.1:9080/v1/forward',
    }).HTTP_EGRESS_PROXY_URL).toContain('127.0.0.1');
  });

  it('rejects malformed egress allowlist entries', () => {
    expect(() => loadConfig({
      HTTP_EGRESS_MODE: 'allowlist',
      HTTP_EGRESS_ALLOWLIST: 'file:///etc/passwd',
    })).toThrow(/invalid HTTP egress allowlist origin/i);
  });

  it('applies bounded MCP defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.MCP_CALL_TIMEOUT_MS).toBe(30_000);
    expect(cfg.MCP_MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(cfg.MCP_MAX_EXTERNAL_TXN_ID_BYTES).toBe(1_024);
    expect(cfg.HTTP_MAX_EXTERNAL_TXN_ID_BYTES).toBe(1_024);
    expect(cfg.TOS_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(cfg.TOS_MAX_ATTEMPTS).toBe(3);
    expect(cfg.TOS_MAX_OBJECT_BYTES).toBe(512 * 1024 * 1024);
    expect(() => loadConfig({ TOS_MAX_ATTEMPTS: '11' })).toThrow();
    expect(() => loadConfig({ TOS_REQUEST_TIMEOUT_MS: '999' })).toThrow();
    expect(() => loadConfig({ TOS_MAX_OBJECT_BYTES: '2147483649' })).toThrow();
  });

  it('uses private WebShell for sandbox data-plane access unless APIG is explicit', () => {
    expect(loadConfig({}).SANDBOX_TRANSPORT).toBe('private-webshell');
    expect(loadConfig({ SANDBOX_TRANSPORT: 'apig' }).SANDBOX_TRANSPORT).toBe('apig');
    expect(() => loadConfig({ SANDBOX_TRANSPORT: 'public' })).toThrow();
  });
});
