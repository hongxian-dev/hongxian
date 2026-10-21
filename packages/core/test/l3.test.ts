import { describe, expect, it } from 'vitest';
import { PayloadL3 } from '@hongxian/schema';
import {
  l3ContainerKey,
  l3FieldKey,
  l3FieldNamesIn,
  openL3Field,
  sealL3Fields,
} from '../src/card/l3.js';
import { makeTestKeyProvider } from './helpers.js';

const l3Key = (() => {
  const { km } = makeTestKeyProvider();
  return km.layerKeys.L3;
})();

describe('见面层逐字段加密（D13：给微信号不给手机号）', () => {
  it('逐字段加密：字段名齐全，容器内没有明文', () => {
    const container = sealL3Fields(
      { contact_wechat: 'wx_001', contact_phone: '13800000000' },
      l3Key,
    );
    expect(container.v).toBe(1);
    expect(l3FieldNamesIn(container).sort()).toEqual(['contact_phone', 'contact_wechat']);
    // 容器里的 ct 是密文——字符串搜索不到原值
    const raw = JSON.stringify(container);
    expect(raw).not.toContain('wx_001');
    expect(raw).not.toContain('13800000000');
  });

  it('授权一个字段：只解得出那一个，另一个的子密钥解不开', () => {
    const container = sealL3Fields(
      { contact_wechat: 'wx_001', contact_phone: '13800000000' },
      l3Key,
    );
    const wx = openL3Field(container, 'contact_wechat', l3FieldKey(l3Key, 'contact_wechat'));
    expect(wx.ok && wx.value).toBe('wx_001');

    // 用微信号的子密钥解手机号：失败（域分离，不是同一把钥匙）
    expect(openL3Field(container, 'contact_phone', l3FieldKey(l3Key, 'contact_wechat')).ok).toBe(false);
    // 容器密钥本身也解不出明文（它只能解外层）
    expect(openL3Field(container, 'contact_wechat', l3ContainerKey(l3Key)).ok).toBe(false);
  });

  it('未授权字段：容器里没有该字段时明确报错', () => {
    const container = sealL3Fields({ contact_wechat: 'wx_001' }, l3Key);
    const r = openL3Field(container, 'contact_phone', l3FieldKey(l3Key, 'contact_phone'));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('未解锁');
  });

  it('字段名白名单：越界字段拒绝加密（不收集身份证/住址等）', () => {
    expect(() => sealL3Fields({ id_card: '310xxx' } as never, l3Key)).toThrow(/白名单/);
    expect(() => sealL3Fields({} as never, l3Key)).toThrow(/没有任何字段/);
  });

  it('v1.0 裸明文兼容：旧卡解封后直接按字段读取', () => {
    const legacy = { contact_wechat: 'old_wx' } as PayloadL3;
    const r = openL3Field(legacy, 'contact_wechat', new Uint8Array(32));
    expect(r.ok && r.value).toBe('old_wx');
    expect(openL3Field(legacy, 'contact_phone', new Uint8Array(32)).ok).toBe(false);
  });
});
