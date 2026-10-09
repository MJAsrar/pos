import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './security.js';

/**
 * These exist because the first version of this policy shipped with no
 * `script-src` at all. Scripts fell back to `default-src 'self'`, which blocked
 * React Fast Refresh's inline preamble and stopped `npm run dev` from booting —
 * a failure invisible to typecheck, tests and the packaged build alike.
 */

function directive(policy: string, name: string): string {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found ?? '';
}

describe('contentSecurityPolicy in production', () => {
  const policy = contentSecurityPolicy(false);

  it('allows no inline script', () => {
    expect(directive(policy, 'script-src')).toBe("script-src 'self'");
    expect(directive(policy, 'script-src')).not.toContain('unsafe-inline');
  });

  it('allows no network of any kind', () => {
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self'");
    expect(policy).not.toContain('ws:');
    expect(policy).not.toContain('localhost');
  });

  it('locks down the dangerous directives', () => {
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'frame-src')).toBe("frame-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(policy, 'form-action')).toBe("form-action 'none'");
  });

  it('still allows the bundled fonts and item photos', () => {
    expect(directive(policy, 'font-src')).toContain("'self'");
    expect(directive(policy, 'img-src')).toContain('data:');
  });
});

describe('contentSecurityPolicy in development', () => {
  const policy = contentSecurityPolicy(true);

  it('allows the inline preamble React Fast Refresh needs', () => {
    expect(directive(policy, 'script-src')).toContain("'unsafe-inline'");
  });

  it('allows the hot-reload websocket', () => {
    expect(directive(policy, 'connect-src')).toContain('ws:');
    expect(directive(policy, 'connect-src')).toContain('127.0.0.1');
  });

  it('keeps every other restriction', () => {
    for (const name of ['object-src', 'frame-src', 'base-uri', 'form-action']) {
      expect(directive(policy, name)).toContain("'none'");
    }
  });
});

describe('the two modes', () => {
  it('differ only in script-src and connect-src', () => {
    const split = (policy: string) =>
      new Map(
        policy
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => [part.split(' ')[0]!, part]),
      );

    const dev = split(contentSecurityPolicy(true));
    const prod = split(contentSecurityPolicy(false));

    expect([...dev.keys()].sort()).toEqual([...prod.keys()].sort());

    const differing = [...dev.keys()].filter((name) => dev.get(name) !== prod.get(name));
    expect(differing.sort()).toEqual(['connect-src', 'script-src']);
  });
});
