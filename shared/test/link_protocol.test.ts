import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/base64url.js';
import { generateVaultId, generateVaultKey } from '../src/crypto.js';
import { buildJoinLink, parseJoinLink } from '../src/link.js';
import { parseClientMessage } from '../src/protocol.js';

describe('join links', () => {
  it('builds and parses', () => {
    const info = { vaultId: generateVaultId(), keyB64: toBase64Url(generateVaultKey()) };
    const link = buildJoinLink('https://notes.example.com/', info);
    expect(link).toBe(`https://notes.example.com/#join=${info.vaultId}.${info.keyB64}`);
    expect(parseJoinLink(link)).toEqual(info);
    expect(parseJoinLink(`#join=${info.vaultId}.${info.keyB64}`)).toEqual(info);
    expect(parseJoinLink(`  join=${info.vaultId}.${info.keyB64}\n`)).toEqual(info);
  });

  it('rejects malformed fragments', () => {
    expect(parseJoinLink('#join=abc.def')).toBeNull();
    expect(parseJoinLink('https://x/#other=1')).toBeNull();
    expect(parseJoinLink('')).toBeNull();
  });
});

describe('client message validation', () => {
  it('accepts well-formed messages and rejects junk', () => {
    const vaultId = generateVaultId();
    const token = toBase64Url(generateVaultKey());
    expect(parseClientMessage({ t: 'auth', vaultId, token, since: 0 })).toEqual({ t: 'auth', vaultId, token, since: 0 });
    expect(parseClientMessage({ t: 'auth', vaultId, token, since: -1 })).toBeNull();
    expect(parseClientMessage({ t: 'auth', vaultId: 'short', token, since: 0 })).toBeNull();
    expect(parseClientMessage({ t: 'update', id: 'a', blob: 'AAAA' })).toEqual({ t: 'update', id: 'a', blob: 'AAAA' });
    expect(parseClientMessage({ t: 'update', id: 'a', blob: '' })).toBeNull();
    expect(parseClientMessage({ t: 'update', id: 'a', blob: 'not base64!' })).toBeNull();
    expect(parseClientMessage({ t: 'awareness', blob: 'x'.repeat(30_000) })).toBeNull();
    expect(parseClientMessage({ t: 'ping' })).toEqual({ t: 'ping' });
    expect(parseClientMessage({ t: 'nope' })).toBeNull();
    expect(parseClientMessage('string')).toBeNull();
  });
});
