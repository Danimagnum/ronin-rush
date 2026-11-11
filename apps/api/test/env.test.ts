import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const core = {
  CORE_URL: 'http://core:3003',
  CORE_JWKS_URL: 'http://core:3003/.well-known/jwks.json',
  CORE_ISSUER: 'https://core.test',
  CORE_AUDIENCE: 'ronin-rush',
  CORE_CLIENT_ID: 'ronin-rush',
  CORE_CLIENT_SECRET: 'secret',
  CORE_HOUSE_ACCOUNT_ID: '00000000-0000-4000-8000-0000000000aa',
};

describe('environment (platform-infra variable names)', () => {
  it('standalone needs no Core settings and names itself ronin-rush', () => {
    const env = loadEnv({});
    expect(env.PLATFORM_MODE).toBe(false);
    expect(env.SERVICE_NAME).toBe('ronin-rush');
  });

  it('PLATFORM_MODE requires every Core setting, issuer and audience included (fail closed)', () => {
    expect(() => loadEnv({ PLATFORM_MODE: 'true' })).toThrow(/CORE_URL[\s\S]*CORE_JWKS_URL[\s\S]*CORE_ISSUER[\s\S]*CORE_AUDIENCE/);
    const { CORE_AUDIENCE: _omit, ...noAudience } = core;
    expect(() => loadEnv({ PLATFORM_MODE: 'true', ...noAudience })).toThrow(/CORE_AUDIENCE/);
    expect(loadEnv({ PLATFORM_MODE: 'true', ...core }).CORE_ISSUER).toBe('https://core.test');
  });

  it('still accepts the pre-0.2.0 PLATFORM_* names, with CORE_* taking precedence', () => {
    const env = loadEnv({
      PLATFORM_MODE: 'true',
      PLATFORM_CORE_URL: 'http://old-core:3003',
      PLATFORM_JWKS_URL: core.CORE_JWKS_URL,
      PLATFORM_JWT_ISSUER: core.CORE_ISSUER,
      PLATFORM_JWT_AUDIENCE: core.CORE_AUDIENCE,
      PLATFORM_CLIENT_ID: 'ronin-rush',
      PLATFORM_CLIENT_SECRET: 'secret',
      PLATFORM_HOUSE_ACCOUNT_ID: core.CORE_HOUSE_ACCOUNT_ID,
      CORE_URL: 'http://core:3003',
    });
    expect(env.CORE_URL).toBe('http://core:3003');
    expect(env.CORE_AUDIENCE).toBe('ronin-rush');
  });
});
