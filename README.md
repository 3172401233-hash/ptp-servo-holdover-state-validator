# ptp-servo-holdover-state-validator

验证 PTP 主从切换、伺服漂移补偿和 holdover 状态机的纯计算模型。

**范围说明：本工具不解析、收发或处理真实 PTP 报文（无网络 socket、无 IEEE 1588
报文编解码）。** 输入是已经抽象好的事件对象（Announce / Sync / Delay_Resp 的
字段、offset、漂移率、holdover 时长、端口能力），输出是主从状态机转换、
时间置信区间和失去同步的原因。它用于验证状态机与误差模型的行为，而不是
替代 ptp4l 之类的真实协议栈。

## 运行

需要 Node.js >= 24（开发验证使用 24.16.0）：

```sh
node --test
```

## 输入模型

```js
import { PtpValidator } from './index.js';

const validator = new PtpValidator({
  masterTimeoutMs: 5000,        // 超过该时长未收到当前 master 消息则进入 holdover
  ports: [{
    portId: 'P1',
    maxDriftPpb: 500,           // 本地晶振相对 master 的最大频率偏差
    holdoverLimitMs: 30000,     // holdover 上限，超限必须停止标记同步
    maxAcceptableErrorNs: 1000, // 可接受误差预算
    expectedDelayNs: 400,       // 期望链路时延（用于估计非对称）
    baseUncertaintyPpb: 5,      // 补偿后的残余漂移底噪
  }],
});

const report = validator.ingest([
  { t: 0,    portId: 'P1', type: 'announce',  gmId: 'GM-A', clockClass: 6, priority1: 100, priority2: 100 },
  { t: 1000, portId: 'P1', type: 'sync',      gmId: 'GM-A', offsetNs: 50, driftPpb: 200 },
  { t: 1000, portId: 'P1', type: 'delayResp', gmId: 'GM-A', measuredDelayNs: 900 },
]);
validator.advanceTo(60000); // 推进逻辑时钟，触发超时 / holdover 检查
```

- 事件按 `(t, seq)` 排序后重放，**输入乱序不影响结果**。
- BMCA 按 `priority1 → clockClass → priority2 → gmId` 字典序比较，小者优；
  `clockClass >= 248` 不可作为 master。

## 输出

`report()` 返回：

- `transitions`：状态机转换日志（`LISTENING / SLAVE / HOLDOVER / LOST`），
  每条含 `t / portId / from / to / reason`。
- `ports[portId]`：`state`、`synchronized`、当前 `master`、
  `driftCompensationPpb`、`residualDriftPpb`、`holdoverMs`、`asymmetryNs`、
  `errorIntervalNs`（`estimateNs ± uncertaintyNs` 的置信区间）和 `lossReason`。

## 关键语义

- **BMCA 选择改变时不沿用旧 master 的漂移补偿**：频率偏差是相对旧 master
  学到的，切换后立即清零（转换原因 `bmca-master-changed-drift-reset`），
  残余漂移回落到 `maxDriftPpb` 量级，直到从 sync/delayResp 重新学习（EMA，α=0.5）。
- **置信区间半宽** = `|offsetNs| + asymmetryNs + residualDriftPpb × 距上次 sync 的秒数`；
  非对称按 `|measuredDelayNs − expectedDelayNs| / 2` 估计。
- **holdover 超限必须停止标记同步**：holdover 时长超过 `holdoverLimitMs` 的端口
  转为 `LOST`，`synchronized = false`，`lossReason = 'holdover-exceeded'`；
  误差超过 `maxAcceptableErrorNs` 的端口同样失去同步标记
  （`lossReason = 'error-budget-exceeded'`）。

## 测试覆盖

`test/validator.test.js` 覆盖：grandmaster 切换（漂移补偿重置）、链路非对称、
holdover 超限、输入乱序，以及 holdover 期间误差随残余漂移增长。
