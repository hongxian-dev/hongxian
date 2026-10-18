import { describe, expect, it } from 'vitest';
import { generateMnemonicZh, mnemonicToSeed } from '../src/mnemonic.js';
import {
  createKeyFiles,
  deriveKeyMaterial,
  generateKeyMaterial,
  keyMaterialId,
  lockKeyMaterial,
  openKeyFile,
  restoreKeyFiles,
  sealKeyFile,
  type SealedKeyFile,
} from '../src/keystore.js';
import { ARGON2_PARAMS } from '../src/kdf.js';

/** 测试用小参数（t=1, m=8MB, p=1）——生产用默认 64MB 档 */
const TEST_PARAMS = { iterations: 1, memorySize: 8192, parallelism: 1, hashLength: 32 };

const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('加密密钥文件（id.enc / kx.enc / lk.enc）', () => {
  it('单文件加密封装 roundtrip', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const plaintext = new TextEncoder().encode('身份私钥种子-32字节');
    const file = await sealKeyFile(plaintext, password, TEST_PARAMS);
    expect(file.v).toBe(1);
    expect(file.salt).not.toBe(file.nonce);
    const back = await openKeyFile(file, password);
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!)).toBe('身份私钥种子-32字节');
  });

  it('错误密码 → null（不泄露任何明文）', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const wrong = mnemonicToSeed(generateMnemonicZh());
    const file = await sealKeyFile(new TextEncoder().encode('secret'), password, TEST_PARAMS);
    expect(await openKeyFile(file, wrong)).toBeNull();
  });

  it('篡改密文 → null（AES-GCM 认证）', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const file = await sealKeyFile(new TextEncoder().encode('secret'), password, TEST_PARAMS);
    const tampered: SealedKeyFile = {
      ...file,
      ct: Buffer.from(Buffer.from(file.ct, 'base64')).toString('base64').slice(0, -4) + 'AAAA',
    };
    expect(await openKeyFile(tampered, password)).toBeNull();
  });

  it('文件版本不匹配 → null（向前兼容防线）', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const file = await sealKeyFile(new TextEncoder().encode('secret'), password, TEST_PARAMS);
    expect(await openKeyFile({ ...file, v: 99 as 1 }, password)).toBeNull();
  });

  it('同明文同密码两次封装 → 不同密文（独立盐 + 随机 nonce）', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const pt = new TextEncoder().encode('same');
    const f1 = await sealKeyFile(pt, password, TEST_PARAMS);
    const f2 = await sealKeyFile(pt, password, TEST_PARAMS);
    expect(f1.salt).not.toBe(f2.salt);
    expect(f1.ct).not.toBe(f2.ct);
  });
});

describe('KeyMaterial 生命周期（D15③ 备份恢复）', () => {
  it('创建三份密钥文件 → 恢复 → 密钥完全一致', async () => {
    const password = mnemonicToSeed(generateMnemonicZh());
    const km = generateKeyMaterial();
    const files = await createKeyFiles(password, km, TEST_PARAMS);
    const restored = await restoreKeyFiles(files, password);
    expect(restored).not.toBeNull();
    expect(bytesEqual(restored!.identityPrivate, km.identityPrivate)).toBe(true);
    expect(bytesEqual(restored!.identityPublic, km.identityPublic)).toBe(true);
    expect(bytesEqual(restored!.kxPrivate, km.kxPrivate)).toBe(true);
    expect(bytesEqual(restored!.kxPublic, km.kxPublic)).toBe(true);
    expect(bytesEqual(restored!.layerKeys.L1, km.layerKeys.L1)).toBe(true);
    expect(bytesEqual(restored!.layerKeys.L2, km.layerKeys.L2)).toBe(true);
    expect(bytesEqual(restored!.layerKeys.L3, km.layerKeys.L3)).toBe(true);
    // 身份连续：恢复后 keyId 不变（换设备不掉线）
    expect(bytesEqual(keyMaterialId(restored!), keyMaterialId(km))).toBe(true);
  });

  it('错误短语恢复 → null', async () => {
    const km = generateKeyMaterial();
    const files = await createKeyFiles(mnemonicToSeed(generateMnemonicZh()), km, TEST_PARAMS);
    const wrongPassword = mnemonicToSeed(generateMnemonicZh());
    expect(await restoreKeyFiles(files, wrongPassword)).toBeNull();
  });

  it('lock 清零敏感字节', () => {
    const km = generateKeyMaterial();
    const priv = km.identityPrivate;
    lockKeyMaterial(km);
    expect(bytesEqual(priv, new Uint8Array(32))).toBe(true);
  });

  it('默认参数为生产档（t=3, m=64MB, p=4）', () => {
    expect(ARGON2_PARAMS.iterations).toBe(3);
    expect(ARGON2_PARAMS.memorySize).toBe(65536);
    expect(ARGON2_PARAMS.parallelism).toBe(4);
    expect(ARGON2_PARAMS.hashLength).toBe(32);
  });
});

describe('短语确定性派生（恢复短语即身份，D15③）', () => {
  it('同短语 → 同身份（keyId 一致，换设备不掉线）', async () => {
    const seed = mnemonicToSeed(generateMnemonicZh());
    const km1 = await deriveKeyMaterial(seed, TEST_PARAMS);
    const km2 = await deriveKeyMaterial(seed, TEST_PARAMS);
    expect(bytesEqual(keyMaterialId(km1), keyMaterialId(km2))).toBe(true);
    expect(bytesEqual(km1.identityPrivate, km2.identityPrivate)).toBe(true);
    expect(bytesEqual(km1.layerKeys.L2, km2.layerKeys.L2)).toBe(true);
    expect(bytesEqual(km1.kxPublic, km2.kxPublic)).toBe(true);
  });

  it('不同短语 → 不同身份', async () => {
    const s1 = mnemonicToSeed(generateMnemonicZh());
    const s2 = mnemonicToSeed(generateMnemonicZh());
    const km1 = await deriveKeyMaterial(s1, TEST_PARAMS);
    const km2 = await deriveKeyMaterial(s2, TEST_PARAMS);
    expect(bytesEqual(keyMaterialId(km1), keyMaterialId(km2))).toBe(false);
  });

  it('派生身份与缓存文件恢复的身份一致（文件只是缓存）', async () => {
    const seed = mnemonicToSeed(generateMnemonicZh());
    const derived = await deriveKeyMaterial(seed, TEST_PARAMS);
    const files = await createKeyFiles(seed, derived, TEST_PARAMS);
    const restored = await restoreKeyFiles(files, seed);
    expect(restored).not.toBeNull();
    expect(bytesEqual(keyMaterialId(restored!), keyMaterialId(derived))).toBe(true);
  });

  it('随机 KeyMaterial 与派生身份不同（v0 行为已被派生取代）', async () => {
    const random = generateKeyMaterial();
    const derived = await deriveKeyMaterial(mnemonicToSeed(generateMnemonicZh()), TEST_PARAMS);
    expect(bytesEqual(keyMaterialId(random), keyMaterialId(derived))).toBe(false);
  });
});
