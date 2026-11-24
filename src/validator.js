import { PtpPort } from './port.js';

// PtpValidator 接收抽象事件（Announce / Sync / Delay_Resp），
// 按 (t, seq) 排序后重放，因此输入乱序不影响结果。
export class PtpValidator {
  constructor({ ports, masterTimeoutMs = 10000 } = {}) {
    if (!Array.isArray(ports) || ports.length === 0) {
      throw new Error('PtpValidator requires a non-empty ports array');
    }
    this.ports = new Map(ports.map((cap) => [cap.portId, new PtpPort(cap, { masterTimeoutMs })]));
    this.now = 0;
  }

  ingest(events) {
    const sorted = events
      .map((ev, index) => ({ ev, index }))
      .sort((a, b) =>
        (a.ev.t - b.ev.t) ||
        ((a.ev.seq ?? a.index) - (b.ev.seq ?? b.index)));
    for (const { ev } of sorted) {
      this._process(ev);
    }
    return this.report();
  }

  advanceTo(t) {
    this.now = Math.max(this.now, t);
    for (const port of this.ports.values()) {
      port.checkTimeouts(t);
    }
    return this.report();
  }

  _process(ev) {
    this.now = Math.max(this.now, ev.t);
    for (const port of this.ports.values()) {
      port.checkTimeouts(ev.t);
    }
    const port = this.ports.get(ev.portId);
    if (port) port.onEvent(ev);
  }

  report() {
    const transitions = [...this.ports.values()]
      .flatMap((port) => port.transitions)
      .sort((a, b) => (a.t - b.t) || a.portId.localeCompare(b.portId));
    const ports = {};
    for (const port of this.ports.values()) {
      ports[port.portId] = port.report(this.now);
    }
    return { t: this.now, transitions, ports };
  }
}
