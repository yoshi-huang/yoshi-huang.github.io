/**
 * ui.js — 視圖層
 *
 * 不做任何 TCP 計算；只讀取 tcpSession.snapshot 和 session.getPacket()。
 *
 * 功能：
 *  - 斜線時序圖 Canvas（拖曳尾端改順序、右鍵丟包）
 *  - Sender 欄左側：此時 Sender 的狀態標注（cwnd、in-flight、sendTime）
 *  - Receiver 欄右側：此時 Receiver 的狀態標注（nextExpAck、收到的 ACK）
 *  - 「檢查模式」：移動滑鼠時，顯示該時間戳兩端傳輸窗口的高亮範圍
 */

'use strict';

(function () {

// ── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dispCwnd     = $('disp-cwnd');
const dispSsthresh = $('disp-ssthresh');
const dispNextAck  = $('disp-nextack');
const dispDupAck   = $('disp-dupack');
const dispState    = $('disp-state');
const eventLogEl   = $('event-log');
const toast        = $('explanation-toast');
const btnReset     = $('btn-reset');
const initialSsthreshInput = $('initial-ssthresh');
const btnApplySsthresh = $('btn-apply-ssthresh');
const initialRtoInput = $('initial-rto');
const btnApplyRto = $('btn-apply-rto');
const totalPacketsInput = $('total-packets');
const btnApplyPackets = $('btn-apply-packets');
const rwndInput = $('rwnd-input');
const rwndValue = $('rwnd-value');
const packetLimitHint = $('packet-limit-hint');
const timeScrubber = $('time-scrubber');
const timeReadout = $('time-readout');
const eventStepBtn = $('event-step');
const eventPlayBtn = $('event-play');
const eventPauseBtn = $('event-pause');
const eventCaption = $('event-caption');
const seqScroll    = $('seq-scroll');
const tooltipEl    = $('seq-tooltip');
let eventLogSource = null;
let eventLogRows = [];
let visibleLogCount = -1;
let currentLogIndex = -1;

// 窗口面板 DOM
const wndSenderTime  = $('wnd-sender-time');
const wndSenderMeta  = $('wnd-sender-meta');
const wndSenderList  = $('wnd-sender-list');
const wndRecvTime    = $('wnd-receiver-time');
const wndRecvMeta    = $('wnd-receiver-meta');
const wndRecvList    = $('wnd-receiver-list');

// ── 模組依賴（只讀）──────────────────────────────────────
const session = window.tcpSession;
const RTT     = window.RTT_UNIT;
const PROP    = window.PROP_DELAY;

// ── Canvas ───────────────────────────────────────────────
let canvas, ctx, chart;

// ─────────────────────────────────────────────────────────
// 時間橫向增加；每個封包固定一列，資料與 ACK 分開走線，避免交叉。
// ─────────────────────────────────────────────────────────
const LABEL_W = 40;
const PAD_RIGHT = 5;
let ROW_H = 20;
const HEADER_H = 30;
const PAD_BOT = 18;
const TIME_ZOOM = 1;
let TIME_SCALE = 10;
let CANVAS_W = 0;
let CANVAS_H = 0;
let MAX_TIME = 0;
let PACKET_SEQS = [];

// ── 命中偵測 ─────────────────────────────────────────────
let hitTargets = [];   // { seq, kind, tipX, tipY, r }

// ── 拖曳狀態 ─────────────────────────────────────────────
let drag = null;   // { seq, startMouseX, startArrivalTime, timeScale }

// ── 檢查模式 ─────────────────────────────────────────────
// 滑鼠在 Canvas 上移動時，我們追蹤游標的「時間座標」
// 並在兩側時間線上繪製當時的窗口高亮
let hoverTime = null;   // 目前滑鼠對應的時間值（null = 不在 Canvas 上）
let animationFrame = 0;
let playingEvents = false;
let playbackTime = -1;
let playbackIndex = 0;
let eventSequence = [];
let dropSequenceIndex = new Map();
let eventSequenceSnapshot = null;
let lastCompletedEventCursor = null;
let activeAnimationEvents = [];
let activeAnimationProgress = 0;
let activeAnimationStartTime = -1;
let lastSenderRowsSignature = null;
let lastReceiverRowsSignature = null;

// ─────────────────────────────────────────────────────────
//  初始化
// ─────────────────────────────────────────────────────────
function init() {
  canvas = document.createElement('canvas');
  canvas.setAttribute('id', 'seq-canvas');
  canvas.setAttribute('aria-label', 'TCP Reno 封包時間軸。時間向右，每列代表一個序號；拖曳資料端點可調整抵達時間，右鍵可切換丟包。');
  seqScroll.innerHTML = '';
  seqScroll.appendChild(canvas);
  ctx = canvas.getContext('2d');

  chart = new window.CwndChart('cwnd-chart');

  canvas.addEventListener('mousedown',    onMouseDown);
  canvas.addEventListener('mousemove',    onMouseMoveCanvas);
  canvas.addEventListener('mouseleave',   onMouseLeaveCanvas);
  canvas.addEventListener('contextmenu',  onContextMenu);
  window.addEventListener('mousemove',    onMouseMoveWindow);
  window.addEventListener('mouseup',      onMouseUp);

  btnReset.addEventListener('click', () => {
    stopEventPlayback(); playbackTime = -1; hoverTime = null;
    session.reset();
    initialSsthreshInput.value = session.getInitialSsthresh();
    initialRtoInput.value = session.getInitialRto();
    totalPacketsInput.value = session.getMaxPackets();
    renderAll();
    showToast('模擬已重置。');
  });

  const applyInitialSsthresh = () => {
    if (!initialSsthreshInput.reportValidity()) return;
    const value = Number(initialSsthreshInput.value);
    if (!session.setInitialSsthresh(value)) return;
    initialSsthreshInput.value = session.getInitialSsthresh();
    hoverTime = null;
    renderAll();
    showToast(`模擬已重置，初始 ssthresh = ${session.getInitialSsthresh()} MSS。`);
  };
  btnApplySsthresh.addEventListener('click', applyInitialSsthresh);
  initialSsthreshInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyInitialSsthresh();
  });

  const applyInitialRto = () => {
    if (!initialRtoInput.reportValidity()) return;
    const value = Number(initialRtoInput.value);
    if (!session.setInitialRto(value)) return;
    initialRtoInput.value = session.getInitialRto();
    hoverTime = null;
    renderAll();
    showToast(`模擬已重置，初始 RTO = ${session.getInitialRto()} ms。`);
  };
  btnApplyRto.addEventListener('click', applyInitialRto);
  initialRtoInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyInitialRto();
  });

  const applyMaxPackets = () => {
    if (!totalPacketsInput.reportValidity()) return;
    stopEventPlayback();
    if (!session.setMaxPackets(Number(totalPacketsInput.value))) return;
    totalPacketsInput.value = session.getMaxPackets();
    syncRwndControl();
    playbackTime = -1; hoverTime = null;
    renderAll();
    showToast(`模擬已重置，總封包數設為 ${session.getMaxPackets()}。`);
  };
  btnApplyPackets.addEventListener('click', applyMaxPackets);
  totalPacketsInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyMaxPackets();
  });

  syncRwndControl();
  rwndInput.addEventListener('input', () => {
    stopEventPlayback();
    session.setRwnd(Number(rwndInput.value));
    syncRwndControl();
    renderAll();
  });

  timeScrubber.addEventListener('input', () => {
    stopEventPlayback();
    lastCompletedEventCursor = null;
    hoverTime = MAX_TIME * (Number(timeScrubber.value) / Number(timeScrubber.max));
    playbackTime = hoverTime;
    refreshEventSequence(session.snapshot);
    revealTimelineTime(hoverTime);
    drawDiagram(session.snapshot);
    renderTimeViews(session.snapshot, hoverTime);
  });

  eventStepBtn.addEventListener('click', () => playNextEvent(false));
  eventPlayBtn.addEventListener('click', () => {
    if (playbackTime < 0 || playbackIndex >= eventSequence.length) {
      playbackTime = -1; playbackIndex = 0; lastCompletedEventCursor = null;
    }
    playingEvents = true;
    eventPlayBtn.disabled = true;
    eventPauseBtn.disabled = false;
    playNextEvent(true);
  });
  eventPauseBtn.addEventListener('click', pauseEventPlayback);

  window.addEventListener('resize', renderAll);
  renderAll();
}

// ─────────────────────────────────────────────────────────
//  全量渲染
// ─────────────────────────────────────────────────────────
function renderAll() {
  const snap = session.snapshot;
  layoutCanvas(snap);
  drawDiagram(snap);
  renderTimeViews(snap, hoverTime);
  packetLimitHint.textContent = `累積確認 ${session.getMaxPackets()} 個封包後停止`;
  refreshEventSequence(snap);
}

function formatRwnd(value) {
  return value === session.getMaxPackets() + 1 ? '無上限' : `${value} MSS`;
}

function syncRwndControl() {
  rwndInput.max = String(session.getMaxPackets() + 1);
  rwndInput.value = String(session.getRwnd());
  rwndValue.value = formatRwnd(session.getRwnd());
}

function refreshEventSequence(snap) {
  if (snap !== eventSequenceSnapshot) {
    eventSequenceSnapshot = snap;
    lastCompletedEventCursor = null;
  }
  eventSequence = snap.drawEvents.flatMap((ev, sourceIndex) => {
    if (ev.kind === 'send' && ev.dropped) {
      const pkt = session.getPacket(ev.seq);
      const end = pkt?.arrivalTime ?? ev.t + PROP;
      return [{ ev: { ...ev, kind: 'loss' }, sourceIndex, time: ev.t + (end - ev.t) * 0.55 }];
    }
    if (ev.kind === 'ack' && ev.dropped) {
      return [{ ev: { ...ev, kind: 'ack-loss' }, sourceIndex, time: ev.tSend + (ev.tArrive - ev.tSend) * 0.55 }];
    }
    if (ev.kind === 'retx' && ev.dropped) {
      return [{ ev: { ...ev, kind: 'retx-loss' }, sourceIndex, time: ev.tSend + (ev.tArrive - ev.tSend) * 0.55 }];
    }
    return [{ ev, sourceIndex, time: ev.tArrive ?? ev.tSend ?? ev.t ?? 0 }];
  })
    .sort((a, b) => a.time - b.time || a.sourceIndex - b.sourceIndex);
  dropSequenceIndex = new Map();
  eventSequence.forEach((item, index) => {
    if (['loss', 'ack-loss', 'retx-loss'].includes(item.ev.kind)) {
      dropSequenceIndex.set(_dropEventKey(item.ev), index);
    }
  });
  playbackIndex = eventSequence.findIndex(item => item.time > playbackTime + 0.001
    || (lastCompletedEventCursor
      && Math.abs(item.time - lastCompletedEventCursor.time) <= 0.001
      && item.sourceIndex > lastCompletedEventCursor.sourceIndex));
  if (playbackIndex < 0) playbackIndex = eventSequence.length;
}

function _dropEventKey(ev) {
  return `${ev.kind}:${ev.seq}:${ev.attempt ?? 0}`;
}

function _dropAnimationPending(kind, seq, attempt = 0) {
  const index = dropSequenceIndex.get(`${kind}:${seq}:${attempt}`);
  return index !== undefined && index >= playbackIndex;
}

function eventDescription(ev) {
  if (ev.kind === 'loss') return { title: `P${ev.seq} LOST`, detail: '資料封包在路徑中斷；TCP 等待 Duplicate ACK 或 RTO 才調整壅塞視窗', tone: 'loss' };
  if (ev.kind === 'ack-loss') return { title: `ACK ${ev.ackNum} LOST`, detail: 'ACK 回程中斷，Sender 不會收到此確認', tone: 'loss' };
  if (ev.kind === 'retx-loss') return { title: `P${ev.seq} 重傳封包 LOST`, detail: `第 ${ev.attempt} 次重傳在路徑中遺失`, tone: 'loss' };
  if (ev.kind === 'send' && ev.dropped) return { title: `P${ev.seq} LOST`, detail: '封包在路徑中遺失，等待 ACK 或 RTO', tone: 'loss' };
  if (ev.kind === 'send') return { title: `P${ev.seq} · DATA 傳送`, detail: `SEQ=${ev.seq} 從 Sender 出發`, tone: 'data' };
  if (ev.kind === 'arrive') return { title: `P${ev.seq} · 抵達 Receiver`, detail: 'Receiver 收到資料並更新累積確認狀態', tone: 'receive' };
  if (ev.kind === 'ack') return { title: `ACK ${ev.ackNum}${ev.isDup ? ' · DUPLICATE ACK' : ' · 累積確認'}`, detail: ev.isDup ? `重複 ACK #${ev.dupN || 1} 回到 Sender` : `確認進度更新至 P${ev.ackNum}`, tone: ev.isDup ? 'dup' : 'ack' };
  if (ev.kind === 'retx') return { title: `P${ev.seq} · RETRANSMISSION`, detail: `第 ${ev.attempt} 次重傳沿資料路徑送出`, tone: 'retx' };
  if (ev.kind === 'timeout') return { title: `RTO TIMEOUT · P${ev.seq}`, detail: `等待逾時；TCP Reno 進入 Slow Start`, tone: 'timeout' };
  return { title: `P${ev.seq} · 網路事件`, detail: 'TCP Reno 狀態已更新', tone: 'receive' };
}

function playNextEvent(continuePlaying) {
  // Keep the cursor advanced by the previous event. Recomputing it from
  // playbackTime here skips sibling events that share the same timestamp.
  if (playbackIndex >= eventSequence.length) {
    if (continuePlaying) stopEventPlayback();
    eventCaption.textContent = '已播放至目前模擬的最後事件';
    return;
  }
  const firstItem = eventSequence[playbackIndex];
  const batchTime = firstItem.time;
  let batchEnd = playbackIndex + 1;
  while (batchEnd < eventSequence.length && Math.abs(eventSequence[batchEnd].time - batchTime) <= 0.001) batchEnd++;
  const batch = eventSequence.slice(playbackIndex, batchEnd);
  const batchEvents = batch.map(item => item.ev);
  const descriptions = batchEvents.map(eventDescription);
  if (batch.length === 1) {
    eventCaption.textContent = `${descriptions[0].title} · ${descriptions[0].detail}`;
  } else {
    const titles = descriptions.slice(0, 3).map(d => d.title).join('、');
    const remainder = batch.length > 3 ? ` 等 ${batch.length} 個事件` : '';
    eventCaption.textContent = `同時發生 ${batch.length} 個事件 · ${titles}${remainder}`;
  }
  const from = Math.min(playbackTime, batchTime);
  activeAnimationStartTime = from;
  const start = performance.now();
  const duration = batchEvents.some(ev => ev.kind === 'timeout') ? 1100
    : batchEvents.some(ev => ev.kind === 'ack' || ev.kind === 'ack-loss') ? 650 : 580;
  const animate = now => {
    const progress = Math.min(1, (now - start) / duration);
    activeAnimationEvents = batchEvents;
    activeAnimationProgress = progress;
    playbackTime = from + (batchTime - from) * (progress * progress * (3 - 2 * progress));
    hoverTime = playbackTime;
    revealTimelineTime(playbackTime);
    drawDiagram(session.snapshot);
    renderTimeViews(session.snapshot, playbackTime);
    if (progress < 1) animationFrame = requestAnimationFrame(animate);
    else {
      playbackTime = batchTime;
      lastCompletedEventCursor = { time: batchTime, sourceIndex: batch[batch.length - 1].sourceIndex };
      playbackIndex = batchEnd;
      activeAnimationEvents = [];
      activeAnimationProgress = 0;
      drawDiagram(session.snapshot);
      renderTimeViews(session.snapshot, playbackTime);
      if (continuePlaying && playingEvents) setTimeout(() => playNextEvent(true), 180);
      else if (!continuePlaying) eventPauseBtn.disabled = true;
    }
  };
  animationFrame = requestAnimationFrame(animate);
}

function stopEventPlayback() {
  playingEvents = false;
  cancelAnimationFrame(animationFrame);
  eventPlayBtn.disabled = false;
  eventPauseBtn.disabled = true;
  activeAnimationEvents = [];
  drawDiagram(session.snapshot);
  activeAnimationStartTime = -1;
}

function pauseEventPlayback() {
  playingEvents = false;
  cancelAnimationFrame(animationFrame);
  eventPlayBtn.disabled = false;
  eventPauseBtn.disabled = true;
  eventCaption.textContent = '已暫停 · 可從目前位置繼續';
}

function renderTimeViews(snap, t) {
  const selectedTime = t === null || t === undefined ? MAX_TIME : t;
  timeScrubber.value = String(Math.round((selectedTime / MAX_TIME) * Number(timeScrubber.max)));
  timeReadout.value = `t=${Math.round(selectedTime)}`;
  timeReadout.textContent = `t=${Math.round(selectedTime)}`;
  renderVars(snap, t);
  renderEventLog(snap, t);
  chart.draw(snap.history, t);
  renderWindowPanels(t);
}

// ─────────────────────────────────────────────────────────
//  Canvas 尺寸
// ─────────────────────────────────────────────────────────
function layoutCanvas(snap) {
  const scrollW = seqScroll.clientWidth || 700;
  const plotW = scrollW - LABEL_W - PAD_RIGHT;
  CANVAS_W = Math.ceil(LABEL_W + plotW * TIME_ZOOM + PAD_RIGHT);
  let maxT = RTT;
  for (const ev of snap.drawEvents) {
    const t = ev.tArrive ?? ev.tSend ?? ev.t ?? 0;
    if (t > maxT) maxT = t;
  }
  for (const pkt of session.getAllPackets()) {
    if (pkt.arrivalTime > maxT) maxT = pkt.arrivalTime;
  }
  MAX_TIME = maxT + RTT * 0.35;
  PACKET_SEQS = [...new Set([
    ...snap.drawEvents.filter(e => e.kind === 'send' || e.kind === 'retx').map(e => e.seq),
    ...session.getAllPackets().map(p => p.seq),
  ])].sort((a, b) => a - b);
  const viewportH = seqScroll.clientHeight || 400;
  const rowCount = Math.max(1, PACKET_SEQS.length);
  ROW_H = Math.max(14, Math.min(20, (viewportH - HEADER_H - PAD_BOT) / rowCount));
  CANVAS_H = Math.max(viewportH, HEADER_H + PACKET_SEQS.length * ROW_H + PAD_BOT);
  TIME_SCALE = Math.max(0.1, (plotW * TIME_ZOOM) / MAX_TIME);

  const dpr = window.devicePixelRatio || 1;
  const scrollTop = seqScroll.scrollTop;
  const scrollLeft = seqScroll.scrollLeft;
  canvas.width = CANVAS_W * dpr;
  canvas.height = CANVAS_H * dpr;
  canvas.style.width = CANVAS_W + 'px';
  canvas.style.height = CANVAS_H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seqScroll.scrollTop = scrollTop;
  seqScroll.scrollLeft = scrollLeft;
}

function tx(t) { return LABEL_W + t * TIME_SCALE; }
function xt(x) { return Math.max(0, (x - LABEL_W) / TIME_SCALE); }
function rowY(seq) { return HEADER_H + PACKET_SEQS.indexOf(seq) * ROW_H; }
function revealTimelineTime(t) {
  const x = tx(t);
  const left = seqScroll.scrollLeft;
  const right = left + seqScroll.clientWidth;
  if (x < left + 40) seqScroll.scrollLeft = Math.max(0, x - 40);
  else if (x > right - 40) seqScroll.scrollLeft = Math.min(CANVAS_W - seqScroll.clientWidth, x - seqScroll.clientWidth + 40);
}

// ─────────────────────────────────────────────────────────
//  主繪圖
// ─────────────────────────────────────────────────────────
function drawDiagram(snap) {
  const W = CANVAS_W;
  const H = CANVAS_H;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, W, H);
  const plotRight = W - PAD_RIGHT;
  const rowBottom = HEADER_H + PACKET_SEQS.length * ROW_H;

  // 時間橫向增加；每個序號一列，資料與 ACK 各有固定軌道。
  ctx.fillStyle = '#f3f7fd';
  ctx.fillRect(0, 0, W, HEADER_H - 3);
  ctx.fillStyle = '#6b7a8e';
  ctx.font = '9px Segoe UI,system-ui,sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('封包', 7, 12);
  
  const tickStep = RTT * Math.max(1, Math.ceil(MAX_TIME / RTT / 12));
  ctx.font = '9px Consolas,Courier New,monospace';
  ctx.textAlign = 'center';
  for (let t = 0; t <= MAX_TIME; t += tickStep) {
    const x = tx(t);
    ctx.strokeStyle = 'rgba(103,122,148,.34)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, HEADER_H - 2); ctx.lineTo(x, rowBottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8491a3';
    ctx.fillText(`${Math.round(t)}`, x, HEADER_H - 5);
  }

  ctx.textAlign = 'left';
  for (const seq of PACKET_SEQS) {
    const y = rowY(seq);
    ctx.fillStyle = seq % 2 ? '#fff' : '#fafbfd';
    ctx.fillRect(0, y, W, ROW_H);
    ctx.strokeStyle = '#dce3ec';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(W, y + ROW_H); ctx.stroke();
    ctx.fillStyle = '#516176';
    ctx.font = `600 ${ROW_H < 16 ? 8 : 9}px Consolas,Courier New,monospace`;
    ctx.fillText(`P${seq}`, 7, y + ROW_H * 0.66);
    ctx.fillStyle = '#d7dee8';
    ctx.fillRect(LABEL_W, y + ROW_H * 0.22, Math.max(1, plotRight - LABEL_W), 1);
    ctx.fillRect(LABEL_W, y + ROW_H * 0.74, Math.max(1, plotRight - LABEL_W), 1);
  }

  hitTargets = [];
  const ackIndexBySeq = new Map();

  for (const ev of snap.drawEvents) {
    if (ev.kind === 'send') drawSendArrow(ev);
    if (ev.kind === 'retx') drawRetxArrow(ev);
    if (ev.kind === 'timeout') drawTimeoutMarker(ev);
    if (ev.kind === 'ack') {
      const seq = ev.seq ?? Math.max(1, ev.ackNum || 1);
      const ackIndex = ackIndexBySeq.get(seq) ?? 0;
      ackIndexBySeq.set(seq, ackIndex + 1);
      drawAckArrow(ev, seq, ackIndex);
    }
  }

  if (hoverTime !== null && hoverTime >= 0) drawInspectOverlay(hoverTime, H);
}

function drawTimeoutMarker(ev) {
  const x = tx(ev.t), y = rowY(ev.seq) + ROW_H * 0.49;
  ctx.save();
  ctx.strokeStyle = '#cf5c5c'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 2.5); ctx.moveTo(x, y); ctx.lineTo(x + 2, y + 1); ctx.stroke();
  ctx.fillStyle = '#a84343'; ctx.font = '7px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('', x + 6, y + 2.5);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  檢查模式 overlay
// ─────────────────────────────────────────────────────────
function drawInspectOverlay(t, H) {
  const x = tx(t);
  ctx.save();
  ctx.strokeStyle = 'rgba(44,79,131,.42)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, HEADER_H - 2); ctx.lineTo(x, H - PAD_BOT); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  drawInFlightPackets(t);
  drawAnimatedEventPacket();
}

function drawInFlightPackets(t) {
  const snap = session.snapshot;
  const drawPacket = (x, y, color, label, lost = false) => {
    ctx.save();
    if (lost) {
      ctx.strokeStyle = '#c84f4f'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
    } else {
      ctx.shadowColor = `${color}70`; ctx.shadowBlur = 8;
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x - 18, y - 6, 36, 12, 3); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = '600 7px Consolas,monospace'; ctx.textAlign = 'center'; ctx.fillText(label, x, y + 2.5);
    }
    ctx.restore();
  };

  for (const ev of snap.drawEvents) {
    if (ev.kind === 'send') {
      if (activeAnimationEvents.some(active => active.kind === 'loss' && active.seq === ev.seq)) continue;
      const pkt = session.getPacket(ev.seq);
      const start = ev.t, end = pkt?.arrivalTime ?? start + PROP;
      if (end <= start) continue;
      const lossTime = start + (end - start) * 0.55;
      if (ev.dropped) {
        const pendingDropAnimation = _dropAnimationPending('loss', ev.seq);
        if (pendingDropAnimation && t >= start) {
          const progress = Math.max(0, Math.min(1, (t - start) / Math.max(1, lossTime - start)));
          drawPacket(tx(start + (lossTime - start) * progress), rowY(ev.seq) + ROW_H * 0.22, '#3474c8', `SEQ ${ev.seq}`);
        } else if (!pendingDropAnimation && t >= lossTime - 8 && t < lossTime + 24) {
          drawPacket(tx(lossTime), rowY(ev.seq) + ROW_H * 0.22, '#c84f4f', '', true);
        }
      } else if (t >= start && t < end) {
        const progress = (t - start) / (end - start);
        drawPacket(tx(start + (end - start) * progress), rowY(ev.seq) + ROW_H * 0.22, '#3474c8', `SEQ ${ev.seq}`);
      }
    } else if (ev.kind === 'retx') {
      if (activeAnimationEvents.some(active => active.kind === 'retx-loss' && active.seq === ev.seq
        && active.attempt === ev.attempt)) continue;
      const start = ev.tSend, end = ev.tArrive;
      const lossTime = start + (end - start) * 0.55;
      const pendingDropAnimation = ev.dropped && _dropAnimationPending('retx-loss', ev.seq, ev.attempt);
      if (end > start && !ev.dropped && t >= start && t < end) {
        const progress = (t - start) / (end - start);
        drawPacket(tx(start + (end - start) * progress), rowY(ev.seq) + ROW_H * 0.48, '#7855b8', `RTX ${ev.seq}`);
      } else if (end > start && pendingDropAnimation && t >= start) {
        const progress = Math.max(0, Math.min(1, (t - start) / Math.max(1, lossTime - start)));
        drawPacket(tx(start + (lossTime - start) * progress), rowY(ev.seq) + ROW_H * 0.48, '#7855b8', `RTX ${ev.seq}`);
      } else if (ev.dropped && !pendingDropAnimation && t >= lossTime - 8 && t < lossTime + 24) {
        drawPacket(tx(lossTime), rowY(ev.seq) + ROW_H * 0.48, '#c84f4f', '', true);
      }
    } else if (ev.kind === 'ack') {
      if (activeAnimationEvents.some(active => active.kind === 'ack-loss' && active.seq === ev.seq
        && active.attempt === ev.attempt)) continue;
      const start = ev.tSend, end = ev.tArrive;
      const lossTime = start + (end - start) * 0.55;
      const y = rowY(ev.seq) + ROW_H * (0.74 + Math.min(ev.dupN ? 1 : 0, 1) * 0.07);
      const pendingDropAnimation = ev.dropped && _dropAnimationPending('ack-loss', ev.seq, ev.attempt);
      if (end > start && !ev.dropped && t >= start && t < end) {
        const progress = (t - start) / (end - start);
        drawPacket(tx(start + (end - start) * progress), y, ev.isDup ? '#c68b24' : '#19865f', `ACK ${ev.ackNum}`);
      } else if (end > start && pendingDropAnimation && t >= start) {
        const progress = Math.max(0, Math.min(1, (t - start) / Math.max(1, lossTime - start)));
        drawPacket(tx(start + (lossTime - start) * progress), y, ev.isDup ? '#c68b24' : '#19865f', `ACK ${ev.ackNum}`);
      } else if (ev.dropped && !pendingDropAnimation && t >= lossTime - 8 && t < lossTime + 24) {
        drawPacket(tx(lossTime), y, '#c84f4f', '', true);
      }
    }
  }
}

function drawAnimatedEventPacket() {
  for (const ev of activeAnimationEvents) {
    if (['loss', 'ack-loss', 'retx-loss'].includes(ev.kind)) {
      drawLossBurst(ev, activeAnimationProgress, activeAnimationStartTime, playbackTime);
    } else if (ev.kind === 'timeout') {
      const cx = tx(ev.t), cy = rowY(ev.seq) + ROW_H * 0.49;
      ctx.save(); ctx.strokeStyle = '#e0a24d'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - activeAnimationProgress)); ctx.stroke();
      ctx.fillStyle = '#c84f4f'; ctx.font = '700 7px Consolas,monospace'; ctx.textAlign = 'center'; ctx.fillText('', cx, cy + 2.5); ctx.restore();
    }
  }
}

function drawLossBurst(ev, progress, animationStartTime, playheadTime) {
  let lossTime, sendTime, y, packetColor, label;
  if (ev.kind === 'loss') {
    const pkt = session.getPacket(ev.seq);
    sendTime = ev.t;
    const end = pkt?.arrivalTime ?? sendTime + PROP;
    lossTime = sendTime + (end - sendTime) * 0.55;
    y = rowY(ev.seq) + ROW_H * 0.22;
    packetColor = '#3474c8'; label = `SEQ ${ev.seq}`;
  } else if (ev.kind === 'retx-loss') {
    sendTime = ev.tSend;
    lossTime = sendTime + (ev.tArrive - sendTime) * 0.55;
    y = rowY(ev.seq) + ROW_H * 0.48;
    packetColor = '#7855b8'; label = `RTX ${ev.seq}`;
  } else {
    sendTime = ev.tSend;
    lossTime = sendTime + (ev.tArrive - sendTime) * 0.55;
    y = rowY(ev.seq) + ROW_H * (0.74 + Math.min(ev.dupN ? 1 : 0, 1) * 0.07);
    packetColor = ev.isDup ? '#c68b24' : '#19865f'; label = `ACK ${ev.ackNum}`;
  }

  const startTime = Math.max(sendTime, Math.min(lossTime, animationStartTime));
  const currentTime = Math.max(startTime, Math.min(lossTime, playheadTime));
  const x = tx(lossTime);
  const packetX = tx(currentTime);
  ctx.save();
  const impactProgress = Math.max(0, Math.min(1, (progress - 0.78) / 0.22));
  const burstAlpha = Math.max(0, 1 - impactProgress);
  if (progress < 0.96) {
    const scale = Math.max(0.35, 1 - impactProgress * 0.65);
    ctx.globalAlpha = progress < 0.78 ? 1 : burstAlpha;
    ctx.shadowColor = '#db4f4f'; ctx.shadowBlur = 12;
    ctx.fillStyle = packetColor;
    ctx.beginPath(); ctx.roundRect(packetX - 18 * scale, y - 6 * scale, 36 * scale, 12 * scale, 3); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = '600 7px Consolas,monospace'; ctx.textAlign = 'center';
    ctx.fillText(label, packetX, y + 2.5 * scale);
  }

  if (progress >= 0.78) {
    const ringRadius = 3 + impactProgress * 18;
    ctx.globalAlpha = burstAlpha * 0.8;
    ctx.strokeStyle = '#dc4d4d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, ringRadius, 0, Math.PI * 2); ctx.stroke();
    const particles = 9;
    for (let i = 0; i < particles; i++) {
      const angle = (Math.PI * 2 * i) / particles - Math.PI / 2;
      const distance = 4 + impactProgress * (12 + (i % 3) * 4);
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance + impactProgress * impactProgress * 13;
      const size = Math.max(1, 3.2 * (1 - impactProgress * 0.7));
      ctx.save(); ctx.translate(px, py); ctx.rotate(angle + impactProgress * 2.2);
      ctx.globalAlpha = burstAlpha;
      ctx.fillStyle = i % 3 === 0 ? '#f08b63' : '#d74747';
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }
  ctx.restore();
}

function _rightArrow(x, y, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(x - 4, y - 3); ctx.lineTo(x, y); ctx.lineTo(x - 4, y + 3); ctx.stroke();
  ctx.restore();
}

function drawSendArrow(ev) {
  const pkt = session.getPacket(ev.seq);
  const x1 = tx(ev.t);
  const y = rowY(ev.seq) + ROW_H * 0.22;
  if (ev.dropped || pkt?.dropped) {
    const x2 = tx(pkt?.arrivalTime ?? ev.t + PROP);
    const xMark = x1 + (x2 - x1) * 0.55;
    ctx.save(); ctx.strokeStyle = '#d85c5c'; ctx.lineWidth = 1.8; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xMark - 4, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(xMark - 3, y - 3); ctx.lineTo(xMark + 3, y + 3); ctx.moveTo(xMark + 3, y - 3); ctx.lineTo(xMark - 3, y + 3); ctx.stroke(); ctx.restore();
    hitTargets.push({ seq: ev.seq, kind: 'arrow-body', tipX: xMark, tipY: y, r: 12 });
    return;
  }
  const x2 = tx(pkt?.arrivalTime ?? (ev.t + PROP));
  ctx.save(); ctx.strokeStyle = '#3474c8'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2 - 4, y); ctx.stroke();
  _rightArrow(x2, y, '#3474c8');
  ctx.fillStyle = '#3474c8'; ctx.beginPath(); ctx.arc(x1, y, 2.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3474c8'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x2, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  hitTargets.push({ seq: ev.seq, kind: 'send-tip', tipX: x2, tipY: y, r: 8 });
  hitTargets.push({ seq: ev.seq, kind: 'arrow-body', x1, x2, lineY: y, tipX: (x1 + x2) / 2, tipY: y, r: 8 });
}

function drawRetxArrow(ev) {
  const x1 = tx(ev.tSend), x2 = tx(ev.tArrive), y = rowY(ev.seq) + ROW_H * 0.48;
  if (ev.dropped) {
    const xm = x1 + (x2 - x1) * 0.55;
    ctx.save(); ctx.strokeStyle = '#d85c5c'; ctx.lineWidth = 1.7; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xm - 4, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(xm - 3, y - 3); ctx.lineTo(xm + 3, y + 3); ctx.moveTo(xm + 3, y - 3); ctx.lineTo(xm - 3, y + 3); ctx.stroke(); ctx.restore();
    hitTargets.push({ seq: ev.seq, attempt: ev.attempt, kind: 'retx', tipX: xm, tipY: y, r: 9 });
    return;
  }
  ctx.save(); ctx.strokeStyle = '#8561b5'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 2]);
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2 - 4, y); ctx.stroke(); ctx.setLineDash([]);
  _rightArrow(x2, y, '#8561b5');
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#8561b5'; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(x2, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  ctx.fillStyle = '#68458f'; ctx.font = '8px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  if (ROW_H >= 18 && x2 - x1 > 42) ctx.fillText('重傳', (x1 + x2) / 2, y - 2);
  hitTargets.push({ seq: ev.seq, attempt: ev.attempt, retxArrivalTime: ev.tArrive, kind: 'retx-tip', tipX: x2, tipY: y, r: 7 });
  hitTargets.push({ seq: ev.seq, attempt: ev.attempt, kind: 'retx', x1, x2, lineY: y, tipX: (x1 + x2) / 2, tipY: y, r: 8 });
}

function drawAckArrow(ev, seq, ackIndex) {
  const x1 = tx(ev.tSend), x2 = tx(ev.tArrive), y = rowY(seq) + ROW_H * (0.74 + Math.min(ackIndex, 1) * 0.07);
  const color = ev.dropped ? '#d85c5c' : (ev.isDup ? '#d79b35' : '#20a879');
  if (ev.dropped) {
    const xm = x1 + (x2 - x1) * 0.55;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xm - 4, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(xm - 3, y - 3); ctx.lineTo(xm + 3, y + 3); ctx.moveTo(xm + 3, y - 3); ctx.lineTo(xm - 3, y + 3); ctx.stroke(); ctx.restore();
    hitTargets.push({ seq, attempt: ev.attempt, ackNum: ev.ackNum, isDup: ev.isDup,
      tSend: ev.tSend, tArrive: ev.tArrive, dropped: true, kind: 'ack', tipX: xm, tipY: y, r: 9 });
    return;
  }
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.35; ctx.setLineDash(ev.isDup ? [2, 2] : []);
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2 - 4, y); ctx.stroke(); ctx.setLineDash([]);
  _rightArrow(x2, y, color); ctx.restore();
  ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(x2, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  hitTargets.push({ seq, attempt: ev.attempt, ackNum: ev.ackNum, isDup: ev.isDup, dupN: ev.dupN,
    ackSendTime: ev.tSend, ackArrivalTime: ev.tArrive, kind: 'ack-tip', tipX: x2, tipY: y, r: 7 });
  hitTargets.push({ seq, attempt: ev.attempt, ackNum: ev.ackNum, isDup: ev.isDup, dupN: ev.dupN,
    tSend: ev.tSend, tArrive: ev.tArrive, kind: 'ack', x1, x2, lineY: y, tipX: (x1 + x2) / 2, tipY: y, r: 8 });
  if (ROW_H >= 18 && x2 - x1 > 56) {
    ctx.fillStyle = ev.isDup ? '#85570c' : '#126b4b'; ctx.font = '8px Segoe UI,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(ev.isDup ? `ACK ${ev.ackNum} · 重複` : `ACK ${ev.ackNum}`, (x1 + x2) / 2, y - 2);
  }
}

// ─────────────────────────────────────────────────────────
//  滑鼠事件
// ─────────────────────────────────────────────────────────
function onMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const pos = _cvPos(e);
  let hit = _findHit(pos.x, pos.y);
  const isDraggableEndpoint = hit && ['send-tip', 'ack-tip', 'retx-tip'].includes(hit.kind);
  stopEventPlayback();
  if (!isDraggableEndpoint) {
    hoverTime = xt(pos.x);
    playbackTime = hoverTime;
    lastCompletedEventCursor = null;
    refreshEventSequence(session.snapshot);
    revealTimelineTime(hoverTime);
    drawDiagram(session.snapshot);
    renderTimeViews(session.snapshot, hoverTime);
    _showTimeTooltip(e.clientX, e.clientY, hoverTime, true);
  }
  hit = isDraggableEndpoint ? _findHit(pos.x, pos.y) : null;
  if (!hit || !['send-tip', 'ack-tip', 'retx-tip'].includes(hit.kind)) return;
  if (hit.kind === 'ack-tip') {
    drag = { type: 'ack', seq: hit.seq, attempt: hit.attempt, startMouseX: e.clientX, startArrivalTime: hit.ackArrivalTime, timeScale: TIME_SCALE };
    _showTooltip(e.clientX, e.clientY, hit);
    return;
  }
  if (hit.kind === 'retx-tip') {
    drag = { type: 'retx', seq: hit.seq, attempt: hit.attempt, startMouseX: e.clientX, startArrivalTime: hit.retxArrivalTime, timeScale: TIME_SCALE };
    _showTooltip(e.clientX, e.clientY, hit);
    return;
  }
  const pkt = session.getPacket(hit.seq);
  if (!pkt) return;
  drag = { type: 'data', seq: hit.seq, startMouseX: e.clientX, startArrivalTime: pkt.arrivalTime, timeScale: TIME_SCALE };
  _showTooltip(e.clientX, e.clientY, hit);
}

// 滑鼠在 Canvas 上移動：更新 hoverTime 並重繪
function onMouseMoveCanvas(e) {
  const pos = _cvPos(e);

  if (!drag) {
    const hit = _findHit(pos.x, pos.y);
    if (hit) {
      _showTooltip(e.clientX, e.clientY, hit);
      canvas.style.cursor = ['send-tip', 'ack-tip', 'retx-tip'].includes(hit.kind) ? 'ew-resize' : 'pointer';
    } else {
      _showTimeTooltip(e.clientX, e.clientY, xt(pos.x), false);
      canvas.style.cursor = '';
    }
    drawDiagram(session.snapshot);   // 時間戳只由點擊或拉桿選取
  }
}

function onMouseLeaveCanvas() {
  if (!drag) {
    _hideTooltip();
  }
}

// 全域 mousemove：拖曳中更新
function onMouseMoveWindow(e) {
  if (!drag) return;
  const dtUnits    = (e.clientX - drag.startMouseX) / drag.timeScale;
  const newArrival = drag.startArrivalTime + dtUnits;
  if (drag.type === 'ack') session.setAckArrival(drag.seq, drag.attempt, newArrival);
  else if (drag.type === 'retx') session.setRetxArrival(drag.seq, drag.attempt, newArrival);
  else session.setArrival(drag.seq, newArrival);
  renderAll();
  const dragEvent = drag.type === 'ack'
    ? session.snapshot.drawEvents.find(ev => ev.kind === 'ack' && ev.seq === drag.seq && (ev.attempt || 0) === drag.attempt)
    : drag.type === 'retx'
      ? session.snapshot.drawEvents.find(ev => ev.kind === 'retx' && ev.seq === drag.seq && ev.attempt === drag.attempt)
      : null;
  if (drag.type === 'data') {
    _showTooltip(e.clientX, e.clientY, { seq: drag.seq, kind: 'send-tip' });
  } else if (dragEvent && drag.type === 'ack') {
    _showTooltip(e.clientX, e.clientY, { ...dragEvent, kind: 'ack-tip', ackNum: dragEvent.ackNum, ackArrivalTime: dragEvent.tArrive });
  } else if (dragEvent) {
    _showTooltip(e.clientX, e.clientY, { ...dragEvent, kind: 'retx-tip', retxArrivalTime: dragEvent.tArrive });
  }
}

function onMouseUp() {
  if (!drag) return;
  drag = null;
  canvas.style.cursor = '';
}

function onContextMenu(e) {
  e.preventDefault();
  const pos = _cvPos(e);
  const hit = _findHit(pos.x, pos.y, 4);
  if (!hit) return;
  if (hit.kind === 'send-tip' || hit.kind === 'arrow-body') {
    session.toggleDrop(hit.seq);
    renderAll();
    const pkt = session.getPacket(hit.seq);
    showToast(pkt?.dropped
      ? `P${hit.seq} 已丟棄（右鍵再次點擊可恢復）`
      : `P${hit.seq} 恢復正常傳送`);
  } else if (hit.kind === 'ack' || hit.kind === 'ack-tip') {
    const dropped = session.toggleAckDrop(hit.seq, hit.attempt);
    renderAll(); showToast(dropped ? `P${hit.seq} 的 ACK 已丟棄` : `P${hit.seq} 的 ACK 已恢復`);
  } else if (hit.kind === 'retx' || hit.kind === 'retx-tip') {
    const dropped = session.toggleRetxDrop(hit.seq, hit.attempt);
    renderAll(); showToast(dropped ? `P${hit.seq} 第 ${hit.attempt} 次重傳已丟棄` : `P${hit.seq} 第 ${hit.attempt} 次重傳已恢復`);
  }
}

// ─────────────────────────────────────────────────────────
//  命中偵測
// ─────────────────────────────────────────────────────────
function _findHit(mx, my, extra = 0) {
  for (const h of hitTargets) {
    if (!['send-tip', 'ack-tip', 'retx-tip'].includes(h.kind)) continue;
    if (_d(mx, my, h.tipX, h.tipY) < h.r + extra) return h;
  }
  for (const h of hitTargets) {
    if (['send-tip', 'ack-tip', 'retx-tip'].includes(h.kind)) continue;
    if (h.x1 !== undefined && h.x2 !== undefined) {
      if (mx >= Math.min(h.x1, h.x2) - extra && mx <= Math.max(h.x1, h.x2) + extra && Math.abs(my - h.lineY) <= h.r + extra) return h;
      continue;
    }
    if (_d(mx, my, h.tipX, h.tipY) < h.r + extra) return h;
  }
  return null;
}

function _d(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function _cvPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ─────────────────────────────────────────────────────────
//  TCP 變數面板
// ─────────────────────────────────────────────────────────
function renderVars(snap, t = null) {
  const fs = t === null || t === undefined ? snap.finalState : session.queryAt(t);
  _animVal(dispCwnd,     fs.cwnd);
  _animVal(dispSsthresh, fs.ssthresh);
  dispNextAck.textContent = fs.nextExpAck;
  dispDupAck.textContent  = fs.dupAckCount + ' / 3';

  const phases = {
    'Slow Start':           ['slow-start',    'Slow Start'],
    'Congestion Avoidance': ['cong-avoid',     'Cong. Avoidance'],
    'Fast Recovery':        ['fast-recovery',  'Fast Recovery'],
  };
  const [cls, label] = phases[fs.tcpPhase] ?? ['slow-start', fs.tcpPhase];
  dispState.textContent = label;
  dispState.className   = 'state-badge ' + cls;
}

function _animVal(el, val) {
  const prev = el.textContent;
  el.textContent = val;
  if (String(prev) !== String(val)) {
    el.classList.add('changed');
    setTimeout(() => el.classList.remove('changed'), 600);
  }
}

// ─────────────────────────────────────────────────────────
//  事件日誌
// ─────────────────────────────────────────────────────────
function renderEventLog(snap, t = null) {
  if (eventLogSource !== snap.log) {
    eventLogEl.replaceChildren();
    eventLogSource = snap.log;
    eventLogRows = new Array(snap.log.length);
    visibleLogCount = -1;
    currentLogIndex = -1;
    const fragment = document.createDocumentFragment();
    for (let i = snap.log.length - 1; i >= 0; i--) {
      const row = createLogRow(snap.log[i]);
      row.hidden = true;
      eventLogRows[i] = row;
      fragment.appendChild(row);
    }
    eventLogEl.appendChild(fragment);
  }

  let nextVisibleCount = snap.log.length;
  if (t !== null && t !== undefined) {
    let low = 0, high = snap.log.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (snap.log[mid].time <= t) low = mid + 1;
      else high = mid;
    }
    nextVisibleCount = low;
  }

  if (nextVisibleCount > visibleLogCount) {
    for (let i = Math.max(0, visibleLogCount); i < nextVisibleCount; i++) eventLogRows[i].hidden = false;
  } else if (nextVisibleCount < visibleLogCount) {
    for (let i = nextVisibleCount; i < visibleLogCount; i++) eventLogRows[i].hidden = true;
  }

  const nextCurrentIndex = nextVisibleCount - 1;
  if (currentLogIndex !== nextCurrentIndex) {
    if (currentLogIndex >= 0) eventLogRows[currentLogIndex].classList.remove('is-current');
    if (nextCurrentIndex >= 0) eventLogRows[nextCurrentIndex].classList.add('is-current');
    currentLogIndex = nextCurrentIndex;
  }
  visibleLogCount = nextVisibleCount;
}

function createLogRow(e) {
    let deltaHtml = '';
    if (e.delta) {
      const { cwnd: c, ssthresh: s } = e.delta;
      const cDir = c.to > c.from ? 'inc' : c.to < c.from ? 'dec' : 'same';
      const sDir = s.to > s.from ? 'inc' : s.to < s.from ? 'dec' : 'same';
      const ca = cDir === 'inc' ? '↑' : cDir === 'dec' ? '↓' : '→';
      const sa = sDir === 'inc' ? '↑' : sDir === 'dec' ? '↓' : '→';
      deltaHtml = `<div class="log-delta">
        cwnd <span class="${cDir}">${c.from} ${ca} ${c.to} MSS</span>
        &nbsp;|&nbsp;
        ssthresh <span class="${sDir}">${s.from} ${sa} ${s.to} MSS</span>
      </div>`;
    }
    const el = document.createElement('div');
    el.className = `log-entry log-${e.type}`;
    el.innerHTML = `
      <span class="log-icon">${e.icon}</span>
      <div class="log-body">
        <div class="log-summary">${e.summary}<span class="event-time">t=${Math.round(e.time ?? 0)}</span></div>
        <div class="log-detail">${e.detail || ''}</div>
        ${deltaHtml}
      </div>`;
    return el;
}

// ─────────────────────────────────────────────────────────
//  Tooltip
// ─────────────────────────────────────────────────────────
function _showTooltip(mx, my, hit) {
  const pkt = session.getPacket(hit.seq);
  if (!pkt) return;
  if (hit.kind === 'ack-tip' || hit.kind === 'ack') {
    const sendTime = hit.ackSendTime ?? hit.tSend;
    const arrivalTime = hit.ackArrivalTime ?? hit.tArrive;
    const ackKind = hit.isDup ? `重複 ACK${hit.dupN ? ` #${hit.dupN}` : ''}` : '累積 ACK';
    tooltipEl.innerHTML = `<strong>${ackKind} ${hit.ackNum}</strong><br/>由 P${hit.seq}（第 ${hit.attempt || 0} 次傳送）觸發<br/>Receiver 發送 t=${Math.round(sendTime)} ms · Sender 收到 t=${Math.round(arrivalTime)} ms${hit.dropped ? '<br/><span style="color:#d85c5c">此 ACK 已丟棄</span>' : ''}<br/><span style="color:#3474c8">${hit.kind === 'ack-tip' ? '↔ 拖曳端點調整回傳時間' : 'ACK 編號依累積確認計算'}</span><br/><span style="color:#fca5a5">右鍵切換 ACK 丟棄</span>`;
    tooltipEl.style.left = `${mx + 12}px`;
    tooltipEl.style.top = `${my + 12}px`;
    tooltipEl.classList.add('visible');
    return;
  }
  if (hit.kind === 'retx-tip') {
    tooltipEl.innerHTML = `<strong>P${hit.seq} 第 ${hit.attempt} 次重傳</strong><br/>抵達 Receiver 時間 = ${Math.round(hit.retxArrivalTime)}<br/><span style="color:#3474c8">↔ 拖曳端點調整抵達時間</span><br/><span style="color:#fca5a5">右鍵丟棄</span>`;
    tooltipEl.style.left = `${mx + 12}px`;
    tooltipEl.style.top = `${my + 12}px`;
    tooltipEl.classList.add('visible');
    return;
  }
  let html = `<strong>P${pkt.seq}</strong>`;
  if (pkt.dropped) {
    html += `<br/><span style="color:#fca5a5">已丟棄</span>`;
    html += `<br/>右鍵再次點擊可恢復`;
  } else {
    html += `<br/>send t = ${Math.round(pkt.sendTime)}`;
    html += `<br/>arrive t = ${Math.round(pkt.arrivalTime)}`;
    if (hit.kind === 'send-tip')
      html += `<br/><span style="color:#3474c8">↔ 拖曳改變抵達時間</span>`;
    html += `<br/><span style="color:#fca5a5">右鍵丟棄</span>`;
  }
  tooltipEl.innerHTML = html;
  tooltipEl.style.left = (mx + 14) + 'px';
  tooltipEl.style.top  = (my - 10) + 'px';
  tooltipEl.classList.add('visible');
}

function _showTimeTooltip(mx, my, time, selected) {
  tooltipEl.innerHTML = `<strong>t = ${Math.round(time)} ms</strong><br/>${selected ? '已選取此時間' : '左鍵點擊以選取此時間'}`;
  tooltipEl.style.left = `${mx + 12}px`;
  tooltipEl.style.top = `${my + 12}px`;
  tooltipEl.classList.add('visible');
}

function _hideTooltip() {
  tooltipEl.classList.remove('visible');
}

// ─────────────────────────────────────────────────────────
//  Toast
// ─────────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

// ─────────────────────────────────────────────────────────
//  窗口狀態面板
//  資料來源：session.queryAt(t)（委派給 TCPReno.queryAt，純函數）
// ─────────────────────────────────────────────────────────

// 狀態文字對照
const SENDER_LABEL = {
  'acked':       '已確認',
  'in-flight':   '已送出，未確認',
  'retx-flight': '重傳中',
  'dropped':     '遺失',
  'not-sent':    '尚未送出',
};
const RECEIVER_LABEL = {
  'acked':       '已確認',
  'arrived-ooo': '收到（亂序/緩衝）',
  'not-arrived': '尚未收到',
  'dropped':     '遺失',
};
const SENDER_CSS = {
  'acked':       's-acked-row',
  'in-flight':   's-in-flight-row',
  'retx-flight': 's-retx-row',
  'dropped':     's-dropped-row',
  'not-sent':    's-notsent-row',
};
const SENDER_BLOCK = {
  'acked':       's-acked',
  'in-flight':   's-in-flight',
  'retx-flight': 's-retx-flight',
  'dropped':     's-dropped',
  'not-sent':    's-not-sent',
};
const RECEIVER_CSS = {
  'acked':       'r-acked-row',
  'arrived-ooo': 'r-ooo-row',
  'not-arrived': '',
  'dropped':     'r-dropped-row',
};
const RECEIVER_BLOCK = {
  'acked':       'r-acked',
  'arrived-ooo': 'r-arrived-ooo',
  'not-arrived': 'r-not-arrived',
  'dropped':     'r-dropped',
};

function renderWindowPanels(t) {
  if (t === null || t === undefined || t < 0) {
    // 未 hover：顯示最終狀態
    _renderPanelIdle();
    return;
  }

  // 呼叫 session.queryAt（它委派給 TCPReno.queryAt，UI 層不計算）
  const snap = session.queryAt(t);

  // ── Sender 面板 ──────────────────────────────
  wndSenderTime.textContent = `t = ${Math.round(t)}`;
  wndSenderMeta.innerHTML =
    `cwnd = <strong>${snap.cwnd}</strong> MSS　`
    + `SND.UNA = <strong>P${snap.sndUna}</strong>　`
    + `窗口上界 = <strong>P${snap.senderWndEnd}</strong>`;

  const senderSignature = `${snap.cwnd}:${snap.sndUna}:${snap.senderWndEnd}|` + snap.senderPackets
    .map(p => `${p.seq}:${p.senderState}:${p.inSendWindow}`).join('|');
  if (senderSignature !== lastSenderRowsSignature) {
  const senderScrollTop = wndSenderList.scrollTop;
  wndSenderList.innerHTML = '';
  // 先判斷是否有任何封包
  if (snap.senderPackets.length === 0) {
    wndSenderList.innerHTML = '<div class="wnd-empty">此時尚無封包</div>';
  } else {
    for (const p of snap.senderPackets) {
      const inWnd = p.inSendWindow;
      const isUna = p.seq === snap.sndUna;
      const isWndEnd = p.seq === snap.senderWndEnd;

      const row = document.createElement('div');
      row.className = [
        'wnd-row',
        SENDER_CSS[p.senderState] ?? '',
        inWnd ? 'in-window' : '',
        isUna ? 'wnd-bracket-top' : '',
        isWndEnd ? 'wnd-bracket-bottom' : '',
      ].filter(Boolean).join(' ');
      row.setAttribute('aria-label', `P${p.seq}，${SENDER_LABEL[p.senderState] ?? p.senderState}${inWnd ? '，位於目前傳送範圍' : ''}`);
      row.title = `P${p.seq} · ${SENDER_LABEL[p.senderState] ?? p.senderState}${inWnd ? ' · 傳送範圍' : ''}`;

      let tagHtml = '';
      if (isUna)    tagHtml += `<span class="wnd-tag tag-una">SND.UNA</span>`;
      if (isWndEnd) tagHtml += `<span class="wnd-tag tag-wnd">WND END</span>`;

      row.innerHTML = `
        <span class="wnd-seq">P${p.seq}</span>
        <span class="wnd-block ${SENDER_BLOCK[p.senderState] ?? ''}" aria-hidden="true"></span>
        <span class="wnd-label" aria-hidden="true">${SENDER_LABEL[p.senderState] ?? p.senderState}</span>
        ${tagHtml}
      `;
      wndSenderList.appendChild(row);
    }
  }
  wndSenderList.scrollTop = senderScrollTop;
  lastSenderRowsSignature = senderSignature;
  }

  // ── Receiver 面板 ────────────────────────────
  wndRecvTime.textContent = `t = ${Math.round(t)}`;
  wndRecvMeta.innerHTML =
    `下一個期望 seq = <strong>P${snap.receiverNextExpAck ?? snap.sndUna}</strong>　`
    + `已確認至 = <strong>P${(snap.receiverCumAck ?? snap.cumAck) || '—'}</strong>　`
    + `rwnd = <strong>${snap.rwnd === Infinity ? '無上限' : (snap.rwnd ?? session.getRwnd()) + ' MSS'}</strong>`;

  const receiverSignature = `${snap.receiverNextExpAck}:${snap.receiverCumAck ?? snap.cumAck}|` + snap.receiverPackets
    .map(p => `${p.seq}:${p.receiverState}`).join('|');
  if (receiverSignature !== lastReceiverRowsSignature) {
  const receiverScrollTop = wndRecvList.scrollTop;
  wndRecvList.innerHTML = '';
  if (snap.receiverPackets.length === 0) {
    wndRecvList.innerHTML = '<div class="wnd-empty">此時尚無封包</div>';
  } else {
    for (const p of snap.receiverPackets) {
      const isNextExp = p.seq === (snap.receiverNextExpAck ?? snap.sndUna);

      const row = document.createElement('div');
      row.className = [
        'wnd-row',
        RECEIVER_CSS[p.receiverState] ?? '',
        isNextExp && p.receiverState !== 'acked' ? 'is-expected' : '',
      ].filter(Boolean).join(' ');
      row.setAttribute('aria-label', `P${p.seq}，${RECEIVER_LABEL[p.receiverState] ?? p.receiverState}${isNextExp && p.receiverState !== 'acked' ? '，下一個預期封包' : ''}`);
      row.title = `P${p.seq} · ${RECEIVER_LABEL[p.receiverState] ?? p.receiverState}${isNextExp && p.receiverState !== 'acked' ? ' · 下一個預期' : ''}`;

      let tagHtml = '';
      if (isNextExp && p.receiverState !== 'acked') {
        tagHtml = `<span class="wnd-tag tag-una">期望</span>`;
      }

      row.innerHTML = `
        <span class="wnd-seq">P${p.seq}</span>
        <span class="wnd-block ${RECEIVER_BLOCK[p.receiverState] ?? ''}" aria-hidden="true"></span>
        <span class="wnd-label" aria-hidden="true">${RECEIVER_LABEL[p.receiverState] ?? p.receiverState}</span>
        ${tagHtml}
      `;
      wndRecvList.appendChild(row);
    }
  }
  wndRecvList.scrollTop = receiverScrollTop;
  lastReceiverRowsSignature = receiverSignature;
  }
}

function _renderPanelIdle() {
  // 顯示模擬最終狀態
  const snap = session.snapshot;
  const fs   = snap.finalState;

  wndSenderTime.textContent = '最終狀態';
  wndSenderMeta.textContent = `cwnd = ${fs.cwnd} MSS  |  ${fs.tcpPhase}`;
  wndSenderList.innerHTML   = '<div class="wnd-empty">移動滑鼠至時序圖，即可查看任意時間點的窗口狀態。</div>';

  wndRecvTime.textContent = '最終狀態';
  wndRecvMeta.textContent = `nextExpAck = P${fs.nextExpAck}`;
  wndRecvList.innerHTML   = '<div class="wnd-empty">移動滑鼠至時序圖，即可查看任意時間點的窗口狀態。</div>';
  lastSenderRowsSignature = null;
  lastReceiverRowsSignature = null;
}

// ── 啟動 ──────────────────────────────────────────────────
if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

})();
