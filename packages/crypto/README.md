# @hongxian/crypto

红线密钥体系。**零网络、零 IO、无随机源之外的副作用**——所有函数都是纯计算。

## 密钥链路

```
24 词恢复短语 (BIP39)
      │  Argon2id（内存硬，抗 GPU 爆破）
      ▼
   主种子
      ├── Ed25519 身份密钥      签名：证明「这张卡是我发的」
      ├── X25519  协商密钥      封装：把对称密钥交给对方
      └── HKDF 派生的层密钥     L1 / L2 / L3，各自独立
```

L3 是 sealed container，每个字段用 `HKDF(L3层密钥, "l3/<字段名>")` 单独派生一把子密钥。
所以「只给微信号、不给手机号」在密码学上成立，不是靠自觉。

## 用法

```ts
import { mnemonicToKeys, signCard, verifyCard, sealLayer, openLayer } from '@hongxian/crypto';

const keys = await mnemonicToKeys(mnemonic);
const sealed = sealLayer(keys.layers.L2, JSON.stringify(payload));
```

## 命令

- **密钥即身份**：没有邮箱、没有手机号、没有密码。恢复短语是唯一备份，丢了就没了，没有找回通道。
- 恢复短语只在本机生成与使用，永不外发。
- 封装用 AES-256-GCM；签名用 Ed25519；协商用 X25519。底层是 audited 的 noble / hash-wasm，不含自研密码学。

## 许可

Apache-2.0。

- 源码：https://github.com/hongxian-dev/hongxian/tree/main/packages/crypto
- 理论说明：https://github.com/hongxian-dev/hongxian/blob/main/spec/protocol-v1-spec.md
