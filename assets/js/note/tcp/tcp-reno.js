/**
 * Event-driven TCP Reno teaching model.
 * Times are milliseconds; sequence numbers and congestion windows are in MSS units.
 */
'use strict';

const DEFAULT_CONFIG = Object.freeze({
  initCwnd: 1,
  initSsthresh: 4,
  propDelay: 60,
  sendSpacing: 0,
  dupAckThresh: 3,
  minSsthresh: 2,
  maxPackets: 48,
  initialRto: 500,
  minRto: 500,
  maxRto: 60000,
  maxRetransmissions: 15,
  maxEvents: 10000,
});

const Phase = Object.freeze({
  SLOW_START: 'Slow Start',
  CONG_AVOID: 'Congestion Avoidance',
  FAST_RECOVERY: 'Fast Recovery',
});

const LOG_ICON = Object.freeze({
  init: '🚀', normal: '✅', dup: '⚠️', fastretx: '🚨',
  recovery: '🔓', send: '📤', retx: '🔁', timeout: '⏱', loss: '✕',
});

function simulate(packetEdits = [], cfg = {}) {
  const C = { ...DEFAULT_CONFIG, ...cfg };
  const edits = new Map(packetEdits.map(p => [p.seq, p]));
  const droppedRetx = new Set(C.droppedRetxKeys || []);
  const droppedAcks = new Set(C.droppedAckKeys || []);
  const queue = [];
  const packets = [];
  const drawEvents = [];
  const history = [];
  const stateTimeline = [];
  const log = [];
  const sentSeqs = new Set();
  const reservedSeqs = new Set();
  const receivedSeqs = new Set();
  const originalSends = new Map();
  let order = 0;
  let nextSeq = 1;
  let receiverNext = 1;
  let senderAck = 0;
  let highestSent = 0;
  let cwnd = C.initCwnd;
  let ssthresh = C.initSsthresh;
  let phase = cwnd >= ssthresh ? Phase.CONG_AVOID : Phase.SLOW_START;
  let dupAckCount = 0;
  let recover = 0;
  let caAckCredit = 0;
  let timerGeneration = 0;
  let timerActive = false;
  let rto = C.initialRto;
  let srtt = null;
  let rttvar = null;
  let timeoutCount = 0;
  let stopped = false;
  let lastReceiverAck = null;
  let lastReceiverAckTime = null;
  let lastSenderAck = null;
  let lastSenderAckTime = null;

  const initial = Object.freeze({
    time: 0, cwnd, ssthresh, tcpPhase: phase, dupAckCount,
    nextExpAck: receiverNext, receiverNextExpAck: receiverNext,
    senderAck, highestSent, rto, rtoDeadline: null,
    lastReceiverAck, lastReceiverAckTime, lastSenderAck, lastSenderAckTime,
  });
  stateTimeline.push(initial);
  history.push({ cwnd, ssthresh, label: 'init', time: 0 });
  log.push(_logEntry('init', '模擬初始化', `初始 cwnd = ${cwnd} MSS，ssthresh = ${ssthresh} MSS；初始 RTO = ${rto} ms。`, null, 0));

  function enqueue(event) {
    event.order = order++;
    queue.push(event);
  }

  function pushState(time) {
    stateTimeline.push(Object.freeze({
      time, cwnd, ssthresh, tcpPhase: phase, dupAckCount,
      nextExpAck: receiverNext, receiverNextExpAck: receiverNext,
      senderAck, highestSent, rto,
      rtoDeadline: timerActive ? currentRtoDeadline : null,
      lastReceiverAck, lastReceiverAckTime, lastSenderAck, lastSenderAckTime,
    }));
  }

  let currentRtoDeadline = null;
  function armTimer(time, restart = false) {
    const outstanding = [...sentSeqs].some(seq => seq > senderAck);
    if (!outstanding) {
      timerActive = false;
      currentRtoDeadline = null;
      timerGeneration++;
      return;
    }
    if (timerActive && !restart) return;
    timerActive = true;
    currentRtoDeadline = time + rto;
    const generation = ++timerGeneration;
    enqueue({ type: 'rto', time: currentRtoDeadline, generation });
  }

  function pushPacket(spec) {
    packets.push(Object.freeze({ ...spec }));
    if (spec.isRetx) {
      drawEvents.push(Object.freeze({ kind: 'retx', seq: spec.seq, attempt: spec.attempt,
        dropped: spec.dropped, tSend: spec.sendTime, tArrive: spec.arrivalTime }));
    } else {
      drawEvents.push(Object.freeze({ kind: 'send', seq: spec.seq, attempt: 0,
        t: spec.sendTime, dropped: spec.dropped, isRetx: false }));
      originalSends.set(spec.seq, spec);
    }
    if (!spec.dropped) enqueue({ type: 'data', time: spec.arrivalTime, packet: spec });
    else log.push(_logEntry('loss', `P${spec.seq}${spec.isRetx ? ` 重傳 #${spec.attempt}` : ''} 丟棄`,
      '封包沒有抵達 Receiver。Sender 仍會等待累積 ACK 或 RTO。', null, spec.sendTime));
  }

  function sendNewData(time) {
    let flightAndReserved = [...sentSeqs, ...reservedSeqs].filter(seq => seq > senderAck).length;
    const segmentLimit = Math.floor(cwnd + 1e-9);
    let index = 0;
    while (nextSeq <= C.maxPackets && flightAndReserved < segmentLimit) {
      const seq = nextSeq++;
      reservedSeqs.add(seq);
      flightAndReserved++;
      enqueue({ type: 'send', time: time + index * C.sendSpacing, seq, attempt: 0 });
      index++;
    }
  }

  function sendRetransmission(seq, time, reason) {
    const attempt = 1 + Math.max(0, ...packets.filter(p => p.seq === seq).map(p => p.attempt || 0));
    if (attempt > C.maxRetransmissions) {
      stopped = true;
      timerActive = false;
      currentRtoDeadline = null;
      log.push(_logEntry('timeout', `P${seq} 已達重傳上限`, '模擬停止重試，避免無限等待。', null, time));
      return false;
    }
    const spec = {
      seq, attempt, sendTime: time,
      arrivalTime: Math.max(time + 1, C.retxArrivalOverrides?.[`${seq}:${attempt}`] ?? time + C.propDelay),
      dropped: droppedRetx.has(`${seq}:${attempt}`), isRetx: true,
    };
    pushPacket(spec);
    log.push(_logEntry('retx', `${reason}：重傳 P${seq}`,
      `保留原序號 P${seq}，第 ${attempt} 次重傳於 t=${time} ms 發送。`, null, time));
    return true;
  }

  function updateRto(sample) {
    if (!(sample > 0) || !Number.isFinite(sample)) return;
    if (srtt === null) {
      srtt = sample;
      rttvar = sample / 2;
    } else {
      rttvar = 0.75 * rttvar + 0.25 * Math.abs(srtt - sample);
      srtt = 0.875 * srtt + 0.125 * sample;
    }
    rto = Math.max(C.minRto, Math.min(C.maxRto, srtt + Math.max(1, 4 * rttvar)));
  }

  function applyCongestionAvoidance(ackedSegments) {
    caAckCredit += ackedSegments / Math.max(cwnd, 1);
    if (caAckCredit >= 1) {
      const increase = Math.floor(caAckCredit);
      cwnd += increase;
      caAckCredit -= increase;
    }
  }

  function sendInitialWindow() {
    sendNewData(0);
  }

  sendInitialWindow();
  let processed = 0;
  while (queue.length && processed++ < C.maxEvents && !stopped) {
    queue.sort((a, b) => a.time - b.time
      || _eventPriority(a.type) - _eventPriority(b.type)
      || a.order - b.order);
    const event = queue.shift();
    const now = event.time;

    if (event.type === 'send') {
      reservedSeqs.delete(event.seq);
      sentSeqs.add(event.seq);
      highestSent = Math.max(highestSent, event.seq);
      const edit = edits.get(event.seq);
      const spec = {
        seq: event.seq, attempt: 0, isRetx: false,
        sendTime: now,
        arrivalTime: Math.max(now + 1, edit?.arrivalTime ?? now + C.propDelay),
        dropped: !!edit?.dropped,
      };
      pushPacket(spec);
      armTimer(now);
      pushState(now);
      continue;
    }

    if (event.type === 'data') {
      const pkt = event.packet;
      drawEvents.push(Object.freeze({ kind: 'arrive', seq: pkt.seq, attempt: pkt.attempt || 0, t: now }));
      receivedSeqs.add(pkt.seq);
      while (receivedSeqs.has(receiverNext)) receiverNext++;
      const ackNum = receiverNext - 1;
      const key = `${pkt.seq}:${pkt.attempt || 0}`;
      const ackDropped = droppedAcks.has(key);
      const ackTime = Math.max(now + 1, C.ackArrivalOverrides?.[key] ?? now + C.propDelay);
      lastReceiverAck = ackNum;
      lastReceiverAckTime = now;
      if (ackDropped) {
        drawEvents.push(Object.freeze({ kind: 'ack', seq: pkt.seq, attempt: pkt.attempt || 0,
          ackNum, tSend: now, tArrive: ackTime, isDup: ackNum <= senderAck, dropped: true }));
        log.push(_logEntry('loss', `ACK ${ackNum} 丟棄`, `P${pkt.seq} 的 ACK 在回程中遺失，Sender 不會收到此確認。`, null, now));
      } else {
        enqueue({ type: 'ack', time: ackTime, seq: pkt.seq, attempt: pkt.attempt || 0,
          ackNum, tSend: now, dataSendTime: pkt.sendTime });
      }
      pushState(now);
      continue;
    }

    if (event.type === 'ack') {
      const { ackNum, seq, attempt } = event;
      lastSenderAck = ackNum;
      lastSenderAckTime = now;
      const isAdvance = ackNum > senderAck;
      const isDuplicate = ackNum === senderAck && senderAck < highestSent;
      let dupN = null;
      if (isDuplicate) dupN = dupAckCount + 1;
      drawEvents.push(Object.freeze({ kind: 'ack', seq, attempt, ackNum,
        tSend: event.tSend, tArrive: now, isDup: isDuplicate, dupN,
        dropped: false }));

      if (isAdvance) {
        const oldAck = senderAck;
        const newlyAcked = ackNum - oldAck;
        senderAck = Math.min(ackNum, highestSent);
        dupAckCount = 0;
        const sampleSpec = originalSends.get(seq);
        const hasRetransmission = packets.some(p => p.seq === seq && p.isRetx);
        if (attempt === 0 && sampleSpec && !hasRetransmission) updateRto(now - sampleSpec.sendTime);

        if (phase === Phase.FAST_RECOVERY) {
          if (senderAck >= recover) {
            cwnd = ssthresh;
            phase = Phase.CONG_AVOID;
            caAckCredit = 0;
            log.push(_logEntry('recovery', `ACK ${senderAck} 確認 recover 邊界，離開 Fast Recovery`,
              `cwnd 回到 ssthresh = ${ssthresh} MSS。`, null, now));
          } else {
            cwnd = Math.max(ssthresh + 1, cwnd - newlyAcked + 1);
            const missing = senderAck + 1;
            log.push(_logEntry('recovery', `Partial ACK ${ackNum}`,
              `仍在 Fast Recovery；立即重傳下一個未確認序號 P${missing}。`, null, now));
            sendRetransmission(missing, now, 'Partial ACK');
          }
        } else if (phase === Phase.SLOW_START) {
          cwnd += newlyAcked;
          if (cwnd >= ssthresh) {
            cwnd = ssthresh;
            phase = Phase.CONG_AVOID;
          }
          log.push(_logEntry('normal', `新 ACK ${senderAck}`, `Slow Start：cwnd 增加 ${newlyAcked} MSS，目前 ${cwnd} MSS。`, null, now));
        } else {
          applyCongestionAvoidance(newlyAcked);
          log.push(_logEntry('normal', `新 ACK ${senderAck}`, `Congestion Avoidance：cwnd = ${cwnd.toFixed(2)} MSS。`, null, now));
        }

        armTimer(now, true);
        history.push({ cwnd, ssthresh, label: `ACK ${senderAck}`, time: now });
        sendNewData(now);
      } else if (isDuplicate) {
        dupAckCount = dupN;
        if (phase === Phase.FAST_RECOVERY) {
          cwnd += 1;
          log.push(_logEntry('dup', `ACK ${ackNum}：Dup ACK #${dupAckCount}，Fast Recovery inflate`,
            `cwnd 增加至 ${cwnd} MSS。`, null, now));
          sendNewData(now);
        } else if (dupAckCount === C.dupAckThresh) {
          const flightSize = [...sentSeqs].filter(n => n > senderAck).length;
          ssthresh = Math.max(C.minSsthresh, Math.floor(flightSize / 2));
          cwnd = ssthresh + C.dupAckThresh;
          recover = highestSent;
          phase = Phase.FAST_RECOVERY;
          log.push(_logEntry('fastretx', `收到第 ${C.dupAckThresh} 個 Dup ACK（ACK ${ackNum}），Fast Retransmit`,
            `ACK ${ackNum} 於 t=${now} ms 抵達 Sender，立即重傳 P${senderAck + 1}；FlightSize=${flightSize}，ssthresh=${ssthresh} MSS，cwnd=${cwnd} MSS。`, null, now));
          sendRetransmission(senderAck + 1, now, 'Fast Retransmit');
          history.push({ cwnd, ssthresh, label: 'Fast Retransmit', time: now });
        } else {
          log.push(_logEntry('dup', `ACK ${ackNum}：Dup ACK #${dupAckCount}`, `仍在等待 P${senderAck + 1}，尚未達到快速重傳門檻。`, null, now));
        }
      } else {
        log.push(_logEntry('normal', `忽略舊 ACK ${ackNum}`, `ACK ${ackNum} 於 t=${now} ms 抵達，但目前 SND.UNA=${senderAck + 1}，不回退累積確認。`, null, now));
      }
      pushState(now);
      continue;
    }

    if (event.type === 'rto') {
      if (!timerActive || event.generation !== timerGeneration) continue;
      const oldest = senderAck + 1;
      if (oldest > highestSent) {
        timerActive = false;
        currentRtoDeadline = null;
        continue;
      }
      timerActive = false;
      currentRtoDeadline = null;
      const flightSize = [...sentSeqs].filter(n => n > senderAck).length;
      ssthresh = Math.max(C.minSsthresh, Math.floor(flightSize / 2));
      cwnd = 1;
      phase = Phase.SLOW_START;
      dupAckCount = 0;
      recover = 0;
      caAckCredit = 0;
      timeoutCount++;
      drawEvents.push(Object.freeze({ kind: 'timeout', seq: oldest, t: now, rto }));
      log.push(_logEntry('timeout', `RTO 到期：重傳 P${oldest}`,
        `FlightSize=${flightSize}；ssthresh=${ssthresh} MSS，cwnd 重設為 1 MSS。RTO ${rto} → ${Math.min(C.maxRto, rto * 2)} ms。`, null, now));
      history.push({ cwnd, ssthresh, label: 'RTO', time: now });
      const wasSent = sendRetransmission(oldest, now, 'RTO');
      if (!wasSent) break;
      rto = Math.min(C.maxRto, rto * 2);
      armTimer(now, true);
      pushState(now);
    }
  }

  if (processed >= C.maxEvents && queue.length) {
    log.push(_logEntry('timeout', '事件數量達上限', '為避免無限重試，模擬在安全上限停止。', null, queue[0].time));
  }

  drawEvents.sort((a, b) => _drawTime(a) - _drawTime(b) || _drawPriority(a.kind) - _drawPriority(b.kind));
  log.sort((a, b) => a.time - b.time);
  history.sort((a, b) => a.time - b.time);
  stateTimeline.sort((a, b) => a.time - b.time);

  const finalState = Object.freeze({
    cwnd, ssthresh, tcpPhase: phase, dupAckCount,
    nextExpAck: senderAck + 1, receiverNextExpAck: receiverNext,
    senderAck, highestSent, recover, rto, srtt, rttvar,
    rtoDeadline: timerActive ? currentRtoDeadline : null,
    timeoutCount, stopped, lastReceiverAck, lastReceiverAckTime, lastSenderAck, lastSenderAckTime,
  });

  return Object.freeze({
    finalState,
    packets: Object.freeze(packets),
    drawEvents: Object.freeze(drawEvents),
    history: Object.freeze(history.map(p => Object.freeze(p))),
    stateTimeline: Object.freeze(stateTimeline),
    log: Object.freeze(log.map(e => Object.freeze(e))),
  });
}

function queryAt(drawEvents, packetSpecs, time, cfg = {}, stateTimeline = []) {
  const C = { ...DEFAULT_CONFIG, ...cfg };
  const timeline = stateTimeline.length ? stateTimeline : [{
    time: 0, cwnd: C.initCwnd, ssthresh: C.initSsthresh,
    tcpPhase: C.initCwnd >= C.initSsthresh ? Phase.CONG_AVOID : Phase.SLOW_START,
    dupAckCount: 0, nextExpAck: 1,
    receiverNextExpAck: 1, senderAck: 0, highestSent: 0,
    lastReceiverAck: null, lastReceiverAckTime: null, lastSenderAck: null, lastSenderAckTime: null,
  }];
  let state = timeline[0];
  for (const point of timeline) {
    if (point.time > time) break;
    state = point;
  }
  const senderAck = state.senderAck ?? (state.nextExpAck - 1);
  const receiverNextExpAck = state.receiverNextExpAck ?? state.nextExpAck;
  const receiverCumAck = receiverNextExpAck - 1;
  const seqs = [...new Set(packetSpecs.map(p => p.seq))].sort((a, b) => a - b);
  const senderPackets = [];
  const receiverPackets = [];

  for (const seq of seqs) {
    const attempts = packetSpecs.filter(p => p.seq === seq && p.sendTime <= time);
    const latest = attempts.at(-1);
    const delivered = attempts.some(p => !p.dropped && p.arrivalTime <= time);
    let senderState;
    if (seq <= senderAck) senderState = 'acked';
    else if (!latest) senderState = 'not-sent';
    else if (!delivered && latest.dropped) senderState = 'dropped';
    else senderState = attempts.some(p => p.isRetx) ? 'retx-flight' : 'in-flight';

    const original = packetSpecs.find(p => p.seq === seq && !p.isRetx);
    let receiverState;
    if (!delivered) receiverState = original?.dropped && attempts.length ? 'dropped' : 'not-arrived';
    else if (seq <= receiverCumAck) receiverState = 'acked';
    else receiverState = 'arrived-ooo';

    senderPackets.push(Object.freeze({
      seq, senderState,
      inCwndWindow: seq >= senderAck + 1 && seq <= senderAck + Math.floor(state.cwnd),
    }));
    receiverPackets.push(Object.freeze({ seq, receiverState }));
  }

  return Object.freeze({
    t: time, cumAck: receiverCumAck, senderCumAck: senderAck, receiverCumAck,
    receiverNextExpAck, sndUna: senderAck + 1, cwnd: state.cwnd,
    ssthresh: state.ssthresh, tcpPhase: state.tcpPhase,
    dupAckCount: state.dupAckCount, nextExpAck: senderAck + 1,
    rto: state.rto, rtoDeadline: state.rtoDeadline,
    lastReceiverAck: state.lastReceiverAck, lastReceiverAckTime: state.lastReceiverAckTime,
    lastSenderAck: state.lastSenderAck, lastSenderAckTime: state.lastSenderAckTime,
    senderWndEnd: senderAck + Math.floor(state.cwnd),
    senderPackets: Object.freeze(senderPackets), receiverPackets: Object.freeze(receiverPackets),
  });
}

function _eventPriority(type) {
  return type === 'data' ? 0 : type === 'send' ? 1 : type === 'ack' ? 2 : 3;
}

function _drawTime(event) {
  return event.t ?? event.tSend ?? 0;
}

function _drawPriority(kind) {
  return kind === 'send' || kind === 'retx' ? 0 : kind === 'arrive' ? 1 : kind === 'ack' ? 2 : 3;
}

function _logEntry(type, summary, detail, delta, time = 0) {
  return Object.freeze({ type, icon: LOG_ICON[type] ?? 'ℹ️', summary, detail, delta: delta ?? null, time });
}

const TCPReno = Object.freeze({ simulate, queryAt });
if (typeof window !== 'undefined') window.TCPReno = TCPReno;
if (typeof module !== 'undefined' && module.exports) module.exports = TCPReno;
