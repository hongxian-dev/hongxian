import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateIdentityKeyPair,
  generateKexKeyPair,
  getKexPublicKey,
  identityPublicKeyFromSeed,
  keyIdFromPublicKey,
  openBox,
  sealBox,
  signDetached,
  verifyDetached,
} from '../src/primitives.js';

describe('Ed25519 身份签名', () => {
  it('签验 roundtrip', () => {
    const kp = generateIdentityKeyPair();
    const msg = new TextEncoder().encode('红线协议 v0 签名测试');
    const sig = signDetached(msg, kp.privateKey);
    expect(sig).toHaveLength(64);
    expect(verifyDetached(sig, msg, kp.publicKey)).toBe(true);
  });

  it('篡改消息 / 篡改签名 / 错公钥 → 验签失败', () => {
    const kp = generateIdentityKeyPair();
    const other = generateIdentityKeyPair();
    const msg = new TextEncoder().encode('原文');
    const sig = signDetached(msg, kp.privateKey);
    expect(verifyDetached(sig, new TextEncoder().encode('篡改'), kp.publicKey)).toBe(false);
    const badSig = new Uint8Array(sig);
    badSig[0] ^= 0xff;
    expect(verifyDetached(badSig, msg, kp.publicKey)).toBe(false);
    expect(verifyDetached(sig, msg, other.publicKey)).toBe(false);
  });

  it('owner_key_id = SHA-256(公钥)，确定性与种子派生一致', () => {
    const kp = generateIdentityKeyPair();
    const id1 = keyIdFromPublicKey(kp.publicKey);
    const id2 = keyIdFromPublicKey(identityPublicKeyFromSeed(kp.privateKey));
    expect(id1).toHaveLength(32);
    expect(Buffer.from(id1).equals(Buffer.from(id2))).toBe(true);
  });
});

describe('X25519 sealed box（换卡即换公钥，Schema §6）', () => {
  it('A 封 B 解：双向互通', () => {
    const a = generateKexKeyPair();
    const b = generateKexKeyPair();
    const secret = new TextEncoder().encode('key_L2-32字节内容');
    const sealedAB = sealBox(secret, b.publicKey);
    const opened = openBox(sealedAB, b.privateKey);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe('key_L2-32字节内容');
    // B 封 A 解
    const sealedBA = sealBox(secret, a.publicKey);
    expect(new TextDecoder().decode(openBox(sealedBA, a.privateKey)!)).toBe('key_L2-32字节内容');
  });

  it('非本方私钥解不开（第三方截获仅得密文）', () => {
    const a = generateKexKeyPair();
    const b = generateKexKeyPair();
    const eve = generateKexKeyPair();
    const sealed = sealBox(new TextEncoder().encode('secret'), b.publicKey);
    expect(openBox(sealed, eve.privateKey)).toBeNull();
    expect(openBox(sealed, a.privateKey)).toBeNull();
  });

  it('篡改密文 → 认证失败返回 null', () => {
    const b = generateKexKeyPair();
    const sealed = sealBox(new TextEncoder().encode('secret'), b.publicKey);
    sealed[50] ^= 0xff;
    expect(openBox(sealed, b.privateKey)).toBeNull();
  });

  it('长度不足的输入拒绝', () => {
    expect(openBox(new Uint8Array(10), generateKexKeyPair().privateKey)).toBeNull();
  });

  it('公钥从种子确定性派生', () => {
    const kp = generateKexKeyPair();
    expect(Buffer.from(getKexPublicKey(kp.privateKey)).equals(Buffer.from(kp.publicKey))).toBe(true);
  });
});

describe('AES-256-GCM', () => {
  it('加解密 roundtrip', () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode('画像明文：喜欢徒步和咖啡');
    const { nonce, ct } = aesGcmEncrypt(key, pt);
    expect(ct.length).toBe(pt.length + 16); // tag 16 字节
    const back = aesGcmDecrypt(key, nonce, ct);
    expect(new TextDecoder().decode(back!)).toBe('画像明文：喜欢徒步和咖啡');
  });

  it('篡改密文 / 错密钥 → null（不降级、不部分解密）', () => {
    const key = randomBytes(32);
    const { nonce, ct } = aesGcmEncrypt(key, new TextEncoder().encode('x'));
    const tampered = new Uint8Array(ct);
    tampered[0] ^= 0xff;
    expect(aesGcmDecrypt(key, nonce, tampered)).toBeNull();
    expect(aesGcmDecrypt(randomBytes(32), nonce, ct)).toBeNull();
  });

  it('非 32 字节密钥拒绝', () => {
    expect(() => aesGcmEncrypt(randomBytes(16), new Uint8Array(1))).toThrow();
  });
});
