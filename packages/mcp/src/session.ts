/**
 * 解锁会话（技术详设 §4：MK 仅存内存，进程退出即清零）
 *
 * 宿主会话期间缓存解锁后的 KeyProvider，避免每次工具调用都要输短语；
 * 可配置超时自动锁定。私钥永不落明文；lock 显式覆写清零。
 */

import {
  createKeyFiles,
  deriveKeyMaterial,
  generateMnemonicZh,
  keyIdFromPublicKey,
  mnemonicToSeed,
  openBox,
  restoreKeyFiles,
  sealBox,
  signDetached,
  zeroize,
  type KeyMaterial,
  type SealedKeyFile,
} from '@hongxian/crypto';
import { toBase64 } from '@hongxian/schema';
import type { DeclaredFilters } from '@hongxian/schema';
import type { KeyProvider } from '@hongxian/core';
import { FsStore, homeExists } from './store-fs.js';

const KEYS_DIR = 'keys';

export interface Settings {
  /** opt-in 匿名计数（E7：默认 false——关闭时零出网） */
  opt_in_counter: boolean;
  /** MK 自动锁定超时（分钟；0 = 进程存活期不锁） */
  lock_timeout_minutes: number;
  /** 模型声明（D7：只声明级别不声明型号） */
  model_tier: 'local' | 'cloud';
  /** 平台服务实例地址（M1.3：月老连哪个自托管/官方实例；显式传入即记住） */
  plaza_instance?: string;
  /**
   * 单条姻缘线的代访 token 预算帽（D9；0 = 不设帽）。
   * 超帽时月老拒绝再发考题包，并给出"提高上限 / 缩短题目"两条路。
   */
  token_budget_cap?: number;
  /**
   * 拉取条件圈（D8）：主人主动声明过的"我要看谁"。
   * 缺省不存在 = 不筛（看全量）——月老不替主人决定"只看同城"。
   */
  plaza_circle?: DeclaredFilters;
  /**
   * 发布许可验证中：本地生成的 nonce（只在这台设备上，与服务端挑战一一对应）。
   *
   * 它是"替他人验证"的防线——想用别人的邮箱验证，得先知道对方的 nonce，
   * 而这个值从未离开过本人的机器。成功认领后即清除。
   */
  publish_nonce?: string;

  /**
   * 已确认过的披露声明版本（防护三 / C2③）。
   *
   * 只在本机；版本号与当前文案不一致就重新展示全文，一致则给一行缩略提示。
   * 这本地的记录只是"省一次阅读"，不是隐私关口——服务端那份（凭据上的
   * `disclosure_version`）才是可追溯的凭证。
   */
  publish_disclosure_version?: string;
}

/** 默认预算帽：8000 token/线——够 3–8 轮结构化问答，远不到"无限网聊" */
export const DEFAULT_TOKEN_BUDGET_CAP = 8000;

const DEFAULT_SETTINGS: Settings = {
  opt_in_counter: false,
  lock_timeout_minutes: 0,
  model_tier: 'local',
  token_budget_cap: DEFAULT_TOKEN_BUDGET_CAP,
};

export class Session {
  private store = new FsStore();
  private km: KeyMaterial | null = null;
  private provider: KeyProvider | null = null;
  private seed: Uint8Array | null = null;
  private lastActivity = 0;

  get unlocked(): boolean {
    return this.km !== null;
  }

  get keyIdB64(): string {
    if (!this.km) throw new Error('未解锁');
    return toBase64(keyIdFromPublicKey(this.km.identityPublic));
  }

  /** 首次启动：生成新身份（24 词恢复短语由调用方展示并强制确认）。
   *  身份由短语确定性派生（恢复短语即身份——D15③） */
  async initIdentity(): Promise<{ mnemonic: string }> {
    const mnemonic = generateMnemonicZh();
    const seed = mnemonicToSeed(mnemonic);
    const km = await deriveKeyMaterial(seed);
    await this.persistKeys(seed, km);
    this.adopt(km, seed);
    return { mnemonic };
  }

  /** 解锁：验证短语并恢复密钥材料 */
  async unlock(phrase: string): Promise<boolean> {
    const seed = mnemonicToSeed(phrase); // 无效短语抛错
    const { id, kx, lk } = {
      id: this.store.read<SealedKeyFile>(`${KEYS_DIR}/id.enc`),
      kx: this.store.read<SealedKeyFile>(`${KEYS_DIR}/kx.enc`),
      lk: this.store.read<SealedKeyFile>(`${KEYS_DIR}/lk.enc`),
    };
    if (!id || !kx || !lk) return false;
    const km = await restoreKeyFiles({ id, kx, lk }, seed);
    if (!km) return false;
    this.adopt(km, seed);
    return true;
  }

  /**
   * 解锁或从短语重建（换设备场景，D15③）：
   * 本机有缓存密钥文件且匹配 → 用文件（免一次 Argon2id 64MB）；
   * 否则（新设备 / 文件丢失）→ 从短语确定性重建同一身份（恢复短语即身份）。
   */
  async unlockOrDerive(phrase: string): Promise<boolean> {
    if (await this.unlock(phrase)) return true;
    try {
      const seed = mnemonicToSeed(phrase);
      const km = await deriveKeyMaterial(seed);
      await this.persistKeys(seed, km);
      this.adopt(km, seed);
      return true;
    } catch {
      return false;
    }
  }

  /** 写入密钥缓存文件（本地性能缓存；身份权威来源是短语本身） */
  private async persistKeys(seed: Uint8Array, km: KeyMaterial): Promise<void> {
    const files = await createKeyFiles(seed, km);
    this.store.write(`${KEYS_DIR}/id.enc`, files.id);
    this.store.write(`${KEYS_DIR}/kx.enc`, files.kx);
    this.store.write(`${KEYS_DIR}/lk.enc`, files.lk);
    // 只在没有设置时写默认值——否则"换设备从短语重建"会把用户已改的
    // opt-in/实例地址/模型声明一并冲掉（v1.1 修复）
    if (!this.store.exists('settings.json')) this.store.write('settings.json', DEFAULT_SETTINGS);
  }

  /** 已初始化身份？（keys 文件存在） */
  get initialized(): boolean {
    return homeExists() && this.store.exists(`${KEYS_DIR}/id.enc`);
  }

  /** 锁定：覆写清零 */
  lock(): void {
    if (this.km) {
      zeroize(
        this.km.identityPrivate,
        this.km.kxPrivate,
        this.km.layerKeys.L1,
        this.km.layerKeys.L2,
        this.km.layerKeys.L3,
      );
    }
    if (this.seed) this.seed.fill(0);
    this.km = null;
    this.provider = null;
    this.seed = null;
  }

  settings(): Settings {
    return this.store.read<Settings>('settings.json') ?? DEFAULT_SETTINGS;
  }

  /**
   * 空闲超时检查（settings.lock_timeout_minutes）。
   *
   * v1.0 只声明了这个配置项却从未执行——用户设了 15 分钟自动锁定，
   * 实际上密钥一直留在内存里，直到进程退出。这里补上真正的门闩：
   * 超时即 lock() 并返回 true，调用方据此提示重新解锁。
   */
  enforceIdleLockout(now: number = Date.now()): boolean {
    if (!this.km) return false;
    const minutes = this.settings().lock_timeout_minutes ?? 0;
    if (minutes <= 0 || this.lastActivity === 0) return false;
    if (now - this.lastActivity < minutes * 60_000) return false;
    this.lock();
    return true;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    this.store.write('settings.json', next);
    return next;
  }

  /** 取 KeyProvider（core 的密码学入口） */
  keyProvider(): KeyProvider {
    if (!this.km || !this.seed) throw new Error('会话未解锁：请先用恢复短语解锁');
    this.lastActivity = Date.now();
    return this.buildProvider(this.km, this.seed);
  }

  /** 取 KeyMaterial（仅限同进程可信路径，如 backup） */
  keyMaterial(): KeyMaterial {
    if (!this.km) throw new Error('会话未解锁：请先用恢复短语解锁');
    return this.km;
  }

  /** 取恢复短语 seed（backup 档案加密用） */
  seedBytes(): Uint8Array {
    if (!this.seed) throw new Error('会话未解锁');
    return this.seed;
  }

  private adopt(km: KeyMaterial, seed: Uint8Array): void {
    this.km = km;
    this.seed = seed;
    this.lastActivity = Date.now();
    this.provider = this.buildProvider(km, seed);
  }

  private buildProvider(km: KeyMaterial, _seed: Uint8Array): KeyProvider {
    return {
      sign: (bytes) => signDetached(bytes, km.identityPrivate),
      identityPublic: () => km.identityPublic,
      keyId: () => keyIdFromPublicKey(km.identityPublic),
      layerKey: (layer) => km.layerKeys[layer],
      sealFor: (recipientPub, plaintext) => sealBox(plaintext, recipientPub),
      openSealed: (sealed) => openBox(sealed, km.kxPrivate),
      kexPublic: () => km.kxPublic,
    };
  }
}
