import { describe, expect, it } from 'vitest';
import {
  FrameError,
  decryptFrame,
  deriveVaultKeys,
  encryptFrame,
  frameAad,
  generateVaultId,
  generateVaultKey,
  utf8Encode,
} from '../src/crypto.js';

describe('vault key derivation', () => {
  it('is deterministic and distinct per purpose', async () => {
    const key = generateVaultKey();
    const id = generateVaultId();
    const a = await deriveVaultKeys(id, key);
    const b = await deriveVaultKeys(id, key);
    expect(a.authToken).toBe(b.authToken);
    expect(a.authToken).toHaveLength(43);
    const other = await deriveVaultKeys(id, generateVaultKey());
    expect(other.authToken).not.toBe(a.authToken);
    expect(a.contentKey.extractable).toBe(false);
  });

  it('rejects wrong key length', async () => {
    await expect(deriveVaultKeys(generateVaultId(), new Uint8Array(16))).rejects.toThrow();
  });
});

describe('frames', () => {
  it('round-trips and uses fresh nonces', async () => {
    const { contentKey, vaultId } = await deriveVaultKeys(generateVaultId(), generateVaultKey());
    const pt = utf8Encode('hello world');
    const f1 = await encryptFrame(contentKey, frameAad(vaultId, 'update'), pt);
    const f2 = await encryptFrame(contentKey, frameAad(vaultId, 'update'), pt);
    expect(f1[0]).toBe(1);
    expect(f1).not.toEqual(f2);
    expect(await decryptFrame(contentKey, frameAad(vaultId, 'update'), f1)).toEqual(pt);
    expect(await decryptFrame(contentKey, frameAad(vaultId, 'update'), f2)).toEqual(pt);
  });

  it('rejects tampering, wrong AAD kind, wrong key and bad versions', async () => {
    const { contentKey, vaultId } = await deriveVaultKeys(generateVaultId(), generateVaultKey());
    const f = await encryptFrame(contentKey, frameAad(vaultId, 'update'), utf8Encode('x'));
    const tampered = new Uint8Array(f);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(decryptFrame(contentKey, frameAad(vaultId, 'update'), tampered)).rejects.toBeInstanceOf(FrameError);
    await expect(decryptFrame(contentKey, frameAad(vaultId, 'snapshot'), f)).rejects.toBeInstanceOf(FrameError);
    const other = await deriveVaultKeys(vaultId, generateVaultKey());
    await expect(decryptFrame(other.contentKey, frameAad(vaultId, 'update'), f)).rejects.toBeInstanceOf(FrameError);
    const badVersion = new Uint8Array(f);
    badVersion[0] = 2;
    await expect(decryptFrame(contentKey, frameAad(vaultId, 'update'), badVersion)).rejects.toThrow(/version/);
    await expect(decryptFrame(contentKey, frameAad(vaultId, 'update'), new Uint8Array(5))).rejects.toThrow(/short/);
  });
});
