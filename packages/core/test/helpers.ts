import {
  generateKeyMaterial,
  keyIdFromPublicKey,
  openBox,
  sealBox,
  signDetached,
  type KeyMaterial,
} from '@hongxian/crypto';
import type { KeyProvider } from '../src/types.js';

/** 用真实 KeyMaterial 构造测试 KeyProvider */
export function makeTestKeyProvider(): {
  key: KeyProvider;
  km: KeyMaterial;
  /** 本方 X25519 协商公钥（"换卡即换公钥"：对端可见、用于加封） */
  kxOther: Uint8Array;
  /** 本方 X25519 私钥 */
  kxOtherPriv: Uint8Array;
} {
  const km = generateKeyMaterial();
  const key: KeyProvider = {
    sign: (bytes) => signDetached(bytes, km.identityPrivate),
    keyId: () => keyIdFromPublicKey(km.identityPublic),
    layerKey: (layer) => km.layerKeys[layer],
    sealFor: (recipientPub, plaintext) => sealBox(plaintext, recipientPub),
    openSealed: (sealed) => openBox(sealed, km.kxPrivate),
    kexPublic: () => km.kxPublic,
  };
  return { key, km, kxOther: km.kxPublic, kxOtherPriv: km.kxPrivate };
}

/** 合法 L1/L2 测试样例（schema 校验通过） */
export const sampleL1 = {
  nickname: '阿泽',
  gender: 'male' as const,
  seeking: 'female' as const,
  age_attested: true as const,
  age_band: '26_30' as const,
  city: { code: '310100', name: '上海' },
  height_band: '171_175' as const,
  marital_status: 'never_married' as const,
  job_category: 'tech' as const,
  education_band: 'bachelor' as const,
  interests: ['outdoor', 'reading', 'food'],
  bio: '写代码也爬山',
  goal: 'marriage_oriented' as const,
  econ_signal: ['independent' as const],
};

export const sampleL2 = {
  values_tags: [
    { tag: 'family_first', weight: 0.8 },
    { tag: 'life_balance', weight: 0.6 },
  ],
  lifestyle: {
    sleep: 'normal',
    smoking: 'never',
    drinking: 'occasionally',
    exercise: 'regularly',
    social: 'medium',
  },
  family_view: {
    parents_relation: 'harmonious',
    childbearing: 'want',
    cohabit_with_parents: 'reluctant',
  },
  money_view: 'balanced',
  assets_brief: { house: 'not_yet', car: 'owned' },
  dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
  values_qa: [
    { question: '理想的一天？', answer: '早起爬山下午写代码' },
    { question: '钱为什么吵架？', answer: '提前说好大额支出' },
    { question: '家是什么？', answer: '可以说累的地方' },
  ],
  partner_pref: '情绪稳定，愿意沟通',
};
