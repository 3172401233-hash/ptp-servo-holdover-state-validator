import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtpValidator, PortState } from '../index.js';

const baseCap = {
  maxDriftPpb: 500,
  holdoverLimitMs: 30000,
  maxAcceptableErrorNs: 1e9,
  expectedDelayNs: 0,
  baseUncertaintyPpb: 5,
};

function announce(t, portId, gmId, { priority1 = 100, clockClass = 6, priority2 = 100 } = {}) {
  return { t, portId, type: 'announce', gmId, clockClass, priority1, priority2 };
}

function sync(t, portId, gmId, { offsetNs = 0, driftPpb } = {}) {
  return { t, portId, type: 'sync', gmId, offsetNs, driftPpb };
}

test('grandmaster 切换：BMCA 选择改变时重置漂移补偿，不沿用旧 master 的值', () => {
  const v = new PtpValidator({ ports: [{ ...baseCap, portId: 'P1' }] });
  const report = v.ingest([
    announce(0, 'P1', 'GM-A', { priority1: 100 }),
    sync(1000, 'P1', 'GM-A', { offsetNs: 50, driftPpb: 200 }),
    sync(2000, 'P1', 'GM-A', { offsetNs: 40, driftPpb: 200 }),
    announce(3000, 'P1', 'GM-B', { priority1: 50 }),
    sync(4000, 'P1', 'GM-B', { offsetNs: 20, driftPpb: 300 }),
  ]);

  const p1 = report.ports.P1;
  assert.equal(p1.master, 'GM-B');
  // 切换后从 GM-B 的 sync 重新学到 300ppb，而不是沿用 GM-A 的 200ppb。
  assert.equal(p1.driftCompensationPpb, 300);

  const switchTransition = report.transitions.find(
    (tr) => tr.reason === 'bmca-master-changed-drift-reset',
  );
  assert.ok(switchTransition, '应记录 master 切换转换');
  assert.equal(switchTransition.t, 3000);
  assert.equal(switchTransition.from, PortState.SLAVE);

  // 切换后、尚未学到新漂移前，残余漂移应回落到 maxDriftPpb 量级，
  // 而不是沿用旧 master 学到的 ~0 残余。
  const v2 = new PtpValidator({ ports: [{ ...baseCap, portId: 'P1' }] });
  const mid = v2.ingest([
    announce(0, 'P1', 'GM-A', { priority1: 100 }),
    sync(1000, 'P1', 'GM-A', { offsetNs: 0, driftPpb: 200 }),
    announce(2000, 'P1', 'GM-B', { priority1: 50 }),
  ]);
  assert.equal(mid.ports.P1.driftCompensationPpb, 0);
  assert.equal(mid.ports.P1.residualDriftPpb, 500 + 5);
});

test('链路非对称：非对称误差计入置信区间，超预算端口失去同步', () => {
  const cap = { ...baseCap, maxAcceptableErrorNs: 1000, expectedDelayNs: 400 };
  const v = new PtpValidator({
    ports: [
      { ...cap, portId: 'ASYMM' },
      { ...cap, portId: 'SYMM' },
    ],
  });
  const report = v.ingest([
    announce(0, 'ASYMM', 'GM-A'),
    announce(0, 'SYMM', 'GM-A'),
    sync(1000, 'ASYMM', 'GM-A', { offsetNs: 0, driftPpb: 0 }),
    sync(1000, 'SYMM', 'GM-A', { offsetNs: 0, driftPpb: 0 }),
    { t: 1000, portId: 'ASYMM', type: 'delayResp', gmId: 'GM-A', measuredDelayNs: 5400 },
    { t: 1000, portId: 'SYMM', type: 'delayResp', gmId: 'GM-A', measuredDelayNs: 400 },
  ]);

  const asym = report.ports.ASYMM;
  assert.equal(asym.state, PortState.SLAVE);
  assert.equal(asym.synchronized, false);
  assert.equal(asym.lossReason, 'error-budget-exceeded');
  assert.equal(asym.asymmetryNs, 2500);
  assert.ok(asym.errorIntervalNs.upperBoundNs - asym.errorIntervalNs.lowerBoundNs >= 5000);

  const sym = report.ports.SYMM;
  assert.equal(sym.synchronized, true);
  assert.equal(sym.lossReason, null);
});

test('holdover 超限：超限端口转为 LOST 并停止标记同步，未超限端口保持', () => {
  const v = new PtpValidator({
    masterTimeoutMs: 5000,
    ports: [
      { ...baseCap, portId: 'SHORT', holdoverLimitMs: 10000 },
      { ...baseCap, portId: 'LONG', holdoverLimitMs: 60000 },
    ],
  });
  v.ingest([
    announce(0, 'SHORT', 'GM-A'),
    announce(0, 'LONG', 'GM-A'),
    sync(1000, 'SHORT', 'GM-A', { offsetNs: 0, driftPpb: 0 }),
    sync(1000, 'LONG', 'GM-A', { offsetNs: 0, driftPpb: 0 }),
  ]);

  // master 消息中断，推进时间进入 holdover。
  const holdover = v.advanceTo(7000);
  assert.equal(holdover.ports.SHORT.state, PortState.HOLDOVER);
  assert.equal(holdover.ports.LONG.state, PortState.HOLDOVER);
  assert.equal(holdover.ports.SHORT.synchronized, true);

  // holdover 时长 11000ms：SHORT（上限 10000）超限，LONG（上限 60000）保持。
  const exceeded = v.advanceTo(18000);
  const short = exceeded.ports.SHORT;
  assert.equal(short.state, PortState.LOST);
  assert.equal(short.synchronized, false);
  assert.equal(short.lossReason, 'holdover-exceeded');
  assert.equal(short.holdoverMs, 11000);

  const long = exceeded.ports.LONG;
  assert.equal(long.state, PortState.HOLDOVER);
  assert.equal(long.synchronized, true);
  assert.equal(long.lossReason, null);

  const reasons = exceeded.transitions.filter((tr) => tr.portId === 'SHORT').map((tr) => tr.reason);
  assert.deepEqual(reasons, ['bmca-master-selected', 'master-timeout', 'holdover-exceeded']);
});

test('输入乱序：按 (t, seq) 重排后结果与顺序输入一致', () => {
  const ports = [
    { ...baseCap, portId: 'P1', maxAcceptableErrorNs: 1000, expectedDelayNs: 400 },
    { ...baseCap, portId: 'P2', holdoverLimitMs: 8000 },
  ];
  const ordered = [
    { seq: 1, ...announce(0, 'P1', 'GM-A', { priority1: 100 }) },
    { seq: 2, ...announce(0, 'P2', 'GM-A', { priority1: 100 }) },
    { seq: 3, ...sync(1000, 'P1', 'GM-A', { offsetNs: 10, driftPpb: 120 }) },
    { seq: 4, ...sync(1000, 'P2', 'GM-A', { offsetNs: -5, driftPpb: 80 }) },
    { seq: 5, t: 1500, portId: 'P1', type: 'delayResp', gmId: 'GM-A', measuredDelayNs: 900 },
    { seq: 6, ...sync(2000, 'P1', 'GM-A', { offsetNs: 8, driftPpb: 140 }) },
    { seq: 7, ...announce(3000, 'P1', 'GM-B', { priority1: 50 }) },
    { seq: 8, ...announce(3000, 'P2', 'GM-B', { priority1: 50 }) },
    { seq: 9, ...sync(4000, 'P1', 'GM-B', { offsetNs: 3, driftPpb: 260 }) },
    { seq: 10, ...sync(4000, 'P2', 'GM-B', { offsetNs: 6, driftPpb: 240 }) },
  ];
  const shuffled = [...ordered].reverse();

  const run = (events) => {
    const v = new PtpValidator({ ports, masterTimeoutMs: 5000 });
    v.ingest(events);
    return v.advanceTo(20000);
  };

  assert.deepEqual(run(shuffled), run(ordered));
});

test('holdover 中误差随残余漂移增长，置信区间变宽', () => {
  const v = new PtpValidator({
    masterTimeoutMs: 5000,
    ports: [{ ...baseCap, portId: 'P1', maxDriftPpb: 100, baseUncertaintyPpb: 0 }],
  });
  v.ingest([
    announce(0, 'P1', 'GM-A'),
    sync(1000, 'P1', 'GM-A', { offsetNs: 0 }),
  ]);
  const early = v.advanceTo(7000).ports.P1;
  const late = v.advanceTo(17000).ports.P1;
  assert.equal(early.state, PortState.HOLDOVER);
  assert.ok(late.uncertaintyNs > early.uncertaintyNs);
  assert.ok(Number.isFinite(late.errorIntervalNs.lowerBoundNs));
});
