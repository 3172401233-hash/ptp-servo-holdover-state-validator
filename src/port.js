import { selectBestMaster } from './bmca.js';

export const PortState = Object.freeze({
  LISTENING: 'LISTENING',
  SLAVE: 'SLAVE',
  HOLDOVER: 'HOLDOVER',
  LOST: 'LOST',
});

const DRIFT_LEARN_ALPHA = 0.5;

export class PtpPort {
  constructor(capability, options) {
    if (!capability || capability.portId == null) {
      throw new Error('port capability requires portId');
    }
    this.portId = capability.portId;
    this.cap = {
      maxDriftPpb: 0,
      holdoverLimitMs: 0,
      maxAcceptableErrorNs: Infinity,
      expectedDelayNs: 0,
      baseUncertaintyPpb: 5,
      ...capability,
    };
    this.masterTimeoutMs = options.masterTimeoutMs;

    this.state = PortState.LISTENING;
    this.master = null;
    this.candidates = new Map();

    // 伺服状态：漂移补偿只对当前 master 有效。
    this.driftCompensationPpb = 0;
    this.driftSamples = 0;
    this.lastDriftSamplePpb = null;

    this.lastMasterMsgT = null;
    this.lastSyncT = null;
    this.offsetNs = 0;
    this.asymmetryNs = 0;
    this.holdoverStartT = null;
    this.holdoverMs = 0;

    this.synchronized = false;
    this.lossReason = null;
    this.transitions = [];
  }

  _transition(t, to, reason) {
    this.transitions.push({ t, portId: this.portId, from: this.state, to, reason });
    this.state = to;
    if (to === PortState.SLAVE) {
      this.holdoverStartT = null;
      this.holdoverMs = 0;
    }
    if (to === PortState.LOST) {
      this.lossReason = reason;
    }
  }

  // BMCA 选择改变时必须丢弃旧 master 的漂移补偿：
  // 频率偏差是相对旧 master 学到的，对新 master 无意义。
  _resetServo() {
    this.driftCompensationPpb = 0;
    this.driftSamples = 0;
    this.lastDriftSamplePpb = null;
  }

  _learnDrift(samplePpb) {
    this.driftSamples += 1;
    this.lastDriftSamplePpb = samplePpb;
    this.driftCompensationPpb = this.driftSamples === 1
      ? samplePpb
      : this.driftCompensationPpb + DRIFT_LEARN_ALPHA * (samplePpb - this.driftCompensationPpb);
  }

  residualDriftPpb() {
    if (this.driftSamples === 0 || this.lastDriftSamplePpb === null) {
      return this.cap.maxDriftPpb + this.cap.baseUncertaintyPpb;
    }
    return Math.abs(this.lastDriftSamplePpb - this.driftCompensationPpb) + this.cap.baseUncertaintyPpb;
  }

  // 时间置信区间半宽：|offset| + 链路非对称 + 残余漂移随时间的累积。
  uncertaintyNs(t) {
    if (this.lastSyncT === null) return Infinity;
    const elapsedS = Math.max(0, t - this.lastSyncT) / 1000;
    return Math.abs(this.offsetNs) + this.asymmetryNs + this.residualDriftPpb() * elapsedS;
  }

  onEvent(ev) {
    const t = ev.t;
    switch (ev.type) {
      case 'announce':
        this._onAnnounce(ev);
        break;
      case 'sync': {
        if (!this.master || ev.gmId !== this.master.gmId) break;
        this.lastMasterMsgT = t;
        this.lastSyncT = t;
        if (typeof ev.offsetNs === 'number') this.offsetNs = ev.offsetNs;
        if (typeof ev.driftPpb === 'number') this._learnDrift(ev.driftPpb);
        if (this.state === PortState.HOLDOVER || this.state === PortState.LOST) {
          this._transition(t, PortState.SLAVE, 'resync');
        }
        break;
      }
      case 'delayResp': {
        if (!this.master || ev.gmId !== this.master.gmId) break;
        this.lastMasterMsgT = t;
        if (typeof ev.measuredDelayNs === 'number') {
          // 非对称 = |实测时延 - 期望时延| / 2（往返均摊假设）。
          this.asymmetryNs = Math.abs(ev.measuredDelayNs - this.cap.expectedDelayNs) / 2;
        }
        if (typeof ev.driftPpb === 'number') this._learnDrift(ev.driftPpb);
        break;
      }
      default:
        break;
    }
    this._refresh(t);
  }

  _onAnnounce(ev) {
    const t = ev.t;
    this.candidates.set(ev.gmId, {
      gmId: ev.gmId,
      clockClass: ev.clockClass,
      priority1: ev.priority1,
      priority2: ev.priority2,
    });
    const best = selectBestMaster(this.candidates);
    const prevGm = this.master?.gmId ?? null;
    const nextGm = best?.gmId ?? null;

    if (nextGm !== prevGm) {
      this.master = best;
      this._resetServo();
      if (best === null) {
        if (this.lastSyncT !== null) {
          this._enterHoldover(t, 'master-degraded');
        } else if (this.state !== PortState.LISTENING) {
          this._transition(t, PortState.LISTENING, 'master-degraded');
        }
      } else {
        const reason = prevGm === null ? 'bmca-master-selected' : 'bmca-master-changed-drift-reset';
        this._transition(t, PortState.SLAVE, reason);
        this.lastMasterMsgT = t;
      }
    }
    if (best && ev.gmId === best.gmId) {
      this.lastMasterMsgT = t;
    }
  }

  _enterHoldover(t, reason) {
    if (this.state === PortState.HOLDOVER) return;
    this.holdoverStartT = t;
    this.holdoverMs = 0;
    this._transition(t, PortState.HOLDOVER, reason);
  }

  checkTimeouts(t) {
    if (
      this.state === PortState.SLAVE &&
      this.lastMasterMsgT !== null &&
      t - this.lastMasterMsgT > this.masterTimeoutMs
    ) {
      this._enterHoldover(t, 'master-timeout');
    }
    if (this.state === PortState.HOLDOVER) {
      this.holdoverMs = t - this.holdoverStartT;
      if (this.holdoverMs > this.cap.holdoverLimitMs) {
        // holdover 超限：必须停止标记为同步。
        this._transition(t, PortState.LOST, 'holdover-exceeded');
      }
    }
    this._refresh(t);
  }

  _refresh(t) {
    if (this.state === PortState.SLAVE || this.state === PortState.HOLDOVER) {
      if (this.uncertaintyNs(t) <= this.cap.maxAcceptableErrorNs) {
        this.synchronized = true;
        this.lossReason = null;
      } else {
        this.synchronized = false;
        this.lossReason = this.lastSyncT === null ? null : 'error-budget-exceeded';
      }
    } else {
      this.synchronized = false;
      if (this.state !== PortState.LOST) this.lossReason = null;
    }
  }

  report(t) {
    const uncertaintyNs = this.uncertaintyNs(t);
    const estimateNs = -this.offsetNs;
    return {
      portId: this.portId,
      state: this.state,
      synchronized: this.synchronized,
      master: this.master?.gmId ?? null,
      driftCompensationPpb: this.driftCompensationPpb,
      residualDriftPpb: this.residualDriftPpb(),
      holdoverMs: this.holdoverMs,
      asymmetryNs: this.asymmetryNs,
      uncertaintyNs,
      errorIntervalNs: uncertaintyNs === Infinity
        ? null
        : {
            estimateNs,
            lowerBoundNs: estimateNs - uncertaintyNs,
            upperBoundNs: estimateNs + uncertaintyNs,
          },
      lossReason: this.lossReason,
    };
  }
}
