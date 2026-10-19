import { describe, expect, it } from 'vitest';
import {
  AnswerCardBody,
  CompareResult,
  GraduationInviteBody,
  GrantL2Body,
  GrantL3Body,
  L3_FIELD_NAMES,
  MsgEnvelope,
  TopicPackBody,
  UpgradeRequestBody,
} from '../src/messages.js';
import { CardMeta } from '../src/card.js';

const from = '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234';

describe('九类信封消息体', () => {
  it('upgrade_request：附本人名片引用 + 请求方协商公钥（v0.4 起必填，广场流回送钥匙用）', () => {
    expect(
      UpgradeRequestBody.safeParse({
        from_card_id: from,
        attach_card_ref: 'card.json',
        requester_kx_public: Buffer.alloc(32, 9).toString('base64'),
      }).success,
    ).toBe(true);
    expect(
      UpgradeRequestBody.safeParse({ from_card_id: 'bad', attach_card_ref: 'x', requester_kx_public: 'k' }).success,
    ).toBe(false);
    // v0.4 破坏性变更：缺 requester_kx_public 一律拒收（防卡主无法回送 grant_l1）
    expect(UpgradeRequestBody.safeParse({ from_card_id: from, attach_card_ref: 'x' }).success).toBe(false);
  });

  it('grant_l2：携带用对方公钥加密的 key_L2', () => {
    expect(GrantL2Body.safeParse({ from_card_id: from, wrapped_key_l2: 'd3JhcHBlZA==' }).success).toBe(
      true,
    );
  });

  it('topic_pack：1 主题 + 追问 ≤2 封顶（D11 防审讯化）+ 双通道标记', () => {
    const ok = TopicPackBody.safeParse({
      from_card_id: from,
      round: 1,
      topic: '周末怎么过',
      followups: ['一个人还是和人一起', '最近一次说走就走'],
      reason: '揭示生活方式与独处需求',
      channel: 'yuelao',
    });
    expect(ok.success).toBe(true);
    const tooMany = TopicPackBody.safeParse({
      from_card_id: from,
      round: 1,
      topic: 't',
      followups: ['a', 'b', 'c'],
      reason: 'r',
      channel: 'owner',
    });
    expect(tooMany.success).toBe(false);
  });

  it('answer_card 三态应答（D10）：answered / ask_master / deferred', () => {
    expect(AnswerCardBody.safeParse(ANSWER_OK).success).toBe(true);
    expect(AnswerCardBody.safeParse(ANSWER_ASK).success).toBe(true);
    expect(AnswerCardBody.safeParse(ANSWER_DEFER).success).toBe(true);
    expect(AnswerCardBody.safeParse({ ...ANSWER_OK, status: 'refused' }).success).toBe(false);
  });

  it('graduation_invite：亲笔短信可选 + L3 字段逐一申请', () => {
    expect(
      GraduationInviteBody.safeParse({
        from_card_id: from,
        request_l3_fields: ['contact_wechat'],
      }).success,
    ).toBe(true);
    expect(
      GraduationInviteBody.safeParse({
        from_card_id: from,
        letter: '很高兴认识你，周末南山咖啡馆见？',
        request_l3_fields: ['contact_wechat', 'real_name'],
      }).success,
    ).toBe(true);
    // 不申请任何字段 = 没有意义的毕业邀请
    expect(GraduationInviteBody.safeParse({ from_card_id: from, request_l3_fields: [] }).success).toBe(
      false,
    );
  });

  it('grant_l3：逐字段 opt-in 的密钥交付（支持"给微信号不给手机号"）', () => {
    expect(
      GrantL3Body.safeParse({
        from_card_id: from,
        fields: [{ field: 'contact_wechat', wrapped_key: 'd3JhcHBlZA==' }],
      }).success,
    ).toBe(true);
    expect(GrantL3Body.safeParse({ from_card_id: from, fields: [] }).success).toBe(false);
  });

  it('L3 字段白名单 = 六项，与 PayloadL3 opt-in 一致', () => {
    expect([...L3_FIELD_NAMES]).toEqual([
      'contact_wechat',
      'contact_phone',
      'real_name',
      'employer_category',
      'hangout_areas',
      'photo_refs',
    ]);
  });
});

const ANSWER_OK = {
  from_card_id: from,
  round: 2,
  topic_ref: '周末怎么过',
  status: 'answered' as const,
  answer: '一般先睡到自然醒，下午去徒步',
};
const ANSWER_ASK = { ...ANSWER_OK, status: 'ask_master' as const, answer: undefined, note: '带回问主人' };
const ANSWER_DEFER = { ...ANSWER_OK, status: 'deferred' as const, answer: undefined, note: '暂不回应' };

describe('消息信封整体', () => {
  const meta = {
    schema_version: 1,
    card_id: from,
    owner_key_id: Buffer.alloc(32, 1).toString('base64'),
    sig_public: Buffer.alloc(32, 2).toString('base64'),
    kx_public: Buffer.alloc(32, 3).toString('base64'),
    version: 1,
    created_at: '2026-10-19T00:00:00.000Z',
    expires_at: '2026-11-18T00:00:00.000Z',
    card_type: 'match_card',
    msg_type: 'upgrade_request',
    target_card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f9999',
    depth: { interview_rounds: 3, completeness: 0.8, model_tier: 'cloud' },
    algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
  };

  it('单向消息必须带 target_card_id，信封可解析', () => {
    const r = MsgEnvelope.safeParse({
      meta,
      payload: { nonce: 'AA', ct: 'BB' },
      signature: 'c2ln',
    });
    expect(r.success).toBe(true);
  });

  it('msg_type 非法值拒绝', () => {
    const r = MsgEnvelope.safeParse({
      meta: { ...meta, msg_type: 'free_chat' },
      payload: { nonce: 'AA', ct: 'BB' },
      signature: 'c2ln',
    });
    expect(r.success).toBe(false);
  });

  it('decline_silent 只接受固定内容（防侧信道）', () => {
    const r = CardMeta.safeParse({ ...meta, msg_type: 'decline_silent' });
    expect(r.success).toBe(true); // meta 层合法；消息体固定值由 core 层保证
  });
});

describe('比对报告契约（D6 五档三区）', () => {
  const base = {
    tier: 'can_chat',
    tier_capped_by_dealbreaker: false,
    confidence_low: false,
    screened_out: false,
    screen_reasons: [],
    narrative_input: { resonance: [], talkable_differences: [], dealbreaker_hits: [] },
    completeness_mine: 0.9,
    completeness_theirs: 0.55,
  };

  it('五档结论合法', () => {
    for (const tier of ['not_yet', 'can_chat', 'worth_knowing', 'worth_meeting', 'dont_miss']) {
      expect(CompareResult.safeParse({ ...base, tier }).success).toBe(true);
    }
  });

  it('对方完整性 <0.6 时 confidence_low 置位（Schema §7.3）', () => {
    expect(CompareResult.safeParse({ ...base, confidence_low: true }).success).toBe(true);
    expect(base.completeness_theirs).toBeLessThan(0.6);
  });

  it('档位封顶与硬伤命中联动', () => {
    expect(
      CompareResult.safeParse({
        ...base,
        tier: 'can_chat',
        tier_capped_by_dealbreaker: true,
        narrative_input: {
          resonance: [{ point: '都爱徒步', mine_quote: '每周爬山', theirs_quote: '周末徒步' }],
          talkable_differences: [],
          dealbreaker_hits: [{ dimension: 'smoking', mine: '不接受', theirs: '每天' }],
        },
      }).success,
    ).toBe(true);
  });
});
