/**
 * tcp-session.js — 使用者操作的狀態管理層
 *
 * 職責：
 *   1. 持有使用者可編輯的封包表（packetList）
 *   2. 回應使用者操作（setArrival、toggleDrop、reset）
 *   3. 操作後呼叫 TCPReno.simulate()，將結果存為唯讀快照
 *   4. 將模擬結果保存為最新快照，供 UI 查詢
 *
 * 不做 TCP 計算，不碰 DOM。
 * UI 層只能透過 session.snapshot 讀取最新結果。
 *
 * 依賴：tcp-reno.js（必須先載入）
 */

'use strict';

// ── 時間常數（與 tcp-reno.js 的 propDelay 對齊）──
// 這裡把它當「顯示用」的常數，也傳進 TCPReno.simulate()
const SESSION_CONFIG = Object.freeze({
  initCwnd:     1,
  initSsthresh: 4,
  propDelay:    60,   // 單程延遲（時間單位）；加大讓斜線看起來更有角度
  initialRto:   500,
  dupAckThresh: 3,
  minSsthresh:  2,
  maxPackets:   48,
});

// RTT_UNIT 只是 UI 用來把時間單位轉成像素的參考值
const RTT_UNIT = SESSION_CONFIG.propDelay * 2;

class TCPSession {
  constructor() {
    this._packetEdits = new Map();
    this.snapshot  = null; // SimulationResult（唯讀，每次 _recalc 後更新）
    this._initialSsthresh = SESSION_CONFIG.initSsthresh;
    this._initialRto = SESSION_CONFIG.initialRto;
    this._maxPackets = SESSION_CONFIG.maxPackets;
    this._droppedRetxKeys = new Set();
    this._droppedAckKeys = new Set();
    this._ackArrivalOverrides = new Map();
    this._retxArrivalOverrides = new Map();
    this._reset();
  }

  // ── 公開操作 ─────────────────────────────────
  // 這三個是使用者唯一可以呼叫的操作。
  // 每次操作後都會呼叫 _recalc()，重新算一遍。

  /** 重置到初始狀態 */
  reset() {
    this._reset();
  }

  /** Set the initial slow-start threshold and restart from that configuration. */
  setInitialSsthresh(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue) || numericValue < 2 || numericValue > 64) return false;
    const nextValue = Math.round(numericValue);
    this._initialSsthresh = nextValue;
    this._reset();
    return true;
  }

  getInitialSsthresh() {
    return this._initialSsthresh;
  }

  setInitialRto(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue) || numericValue < 500 || numericValue > 60000) return false;
    this._initialRto = numericValue;
    this._reset();
    return true;
  }

  getInitialRto() {
    return this._initialRto;
  }

  setMaxPackets(value) {
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue) || numericValue < 1 || numericValue > 500) return false;
    this._maxPackets = numericValue;
    this._reset();
    return true;
  }

  getMaxPackets() {
    return this._maxPackets;
  }

  /**
   * 拖曳封包尾端：改變 arrivalTime
   * @param {number} seq
   * @param {number} newArrivalTime
   */
  setArrival(seq, newArrivalTime) {
    const pkt = this._findOriginal(seq);
    if (!pkt) return;
    const edit = this._packetEdits.get(seq) || { ...pkt };
    edit.arrivalTime = Math.max(pkt.sendTime + 1, newArrivalTime);
    this._packetEdits.set(seq, edit);
    this._recalc();
  }

  /**
   * 右鍵：toggle 是否丟棄
   * @param {number} seq
   */
  toggleDrop(seq) {
    const pkt = this._findOriginal(seq);
    if (!pkt) return;
    const edit = this._packetEdits.get(seq) || { ...pkt };
    edit.dropped = !edit.dropped;
    this._packetEdits.set(seq, edit);
    this._recalc();
  }

  toggleRetxDrop(seq, attempt) {
    const key = _attemptKey(seq, attempt);
    this._toggleSetValue(this._droppedRetxKeys, key);
    this._recalc();
    return this._droppedRetxKeys.has(key);
  }

  toggleAckDrop(seq, attempt) {
    const key = _attemptKey(seq, attempt);
    this._toggleSetValue(this._droppedAckKeys, key);
    this._recalc();
    return this._droppedAckKeys.has(key);
  }

  setAckArrival(seq, attempt, time) {
    const key = _attemptKey(seq, attempt);
    const event = this.snapshot.drawEvents.find(e => e.kind === 'ack' && e.seq === seq && (e.attempt || 0) === attempt);
    if (!event || event.dropped || !Number.isFinite(time)) return;
    this._ackArrivalOverrides.set(key, Math.max(event.tSend + 1, time));
    this._recalc();
  }

  setRetxArrival(seq, attempt, time) {
    const key = _attemptKey(seq, attempt);
    const event = this.snapshot.drawEvents.find(e => e.kind === 'retx' && e.seq === seq && e.attempt === attempt);
    if (!event || event.dropped || !Number.isFinite(time)) return;
    this._retxArrivalOverrides.set(key, Math.max(event.tSend + 1, time));
    this._recalc();
  }

  // ── 查詢方法（唯讀）────────────────────────────

  /**
   * 取得指定 seq 的封包規格（唯讀拷貝）
   * @returns {Readonly<PacketSpec>|null}
   */
  getPacket(seq) {
    const p = this.snapshot?.packets.find(p => p.seq === seq && !p.isRetx);
    return p ? Object.freeze({ ...p }) : null;
  }

  /**
   * 取得所有封包的唯讀陣列拷貝
   * @returns {Readonly<PacketSpec>[]}
   */
  getAllPackets() {
    return Object.freeze((this.snapshot?.packets || []).map(p => Object.freeze({ ...p })));
  }

  /**
   * 查詢指定時間點兩端的窗口狀態（純唯讀，委派給 TCPReno.queryAt）
   * @param {number} t
   * @returns {WindowSnapshot}
   */
  queryAt(t) {
    return window.TCPReno.queryAt(
      this.snapshot.drawEvents,
      this.getAllPackets(),
      t,
      Object.assign({}, SESSION_CONFIG, { initSsthresh: this._initialSsthresh, initialRto: this._initialRto }),
      this.snapshot.stateTimeline
    );
  }

  // ── 私有方法 ─────────────────────────────────

  _reset() {
    this._droppedRetxKeys.clear();
    this._droppedAckKeys.clear();
    this._ackArrivalOverrides.clear();
    this._retxArrivalOverrides.clear();
    this._packetEdits.clear();
    // 初始窗口中的封包以同一時刻發送。
    for (let i = 1; i <= SESSION_CONFIG.initCwnd; i++) {
      this._packetEdits.set(i, {
        seq:         i,
        attempt:     0,
        sendTime:    0,
        arrivalTime: SESSION_CONFIG.propDelay,
        dropped:     false,
        isRetx:      false,
      });
    }
    this._recalc();
  }

  _recalc() {
    const result = window.TCPReno.simulate([...this._packetEdits.values()], Object.assign({}, SESSION_CONFIG, {
      initSsthresh: this._initialSsthresh,
      initialRto: this._initialRto,
      maxPackets: this._maxPackets,
      droppedRetxKeys: [...this._droppedRetxKeys],
      droppedAckKeys: [...this._droppedAckKeys],
      ackArrivalOverrides: Object.fromEntries(this._ackArrivalOverrides),
      retxArrivalOverrides: Object.fromEntries(this._retxArrivalOverrides),
    }));

    this.snapshot = result;
  }

  /**
   * 只找「原始（非重傳）」的封包
   * 使用者拖曳或丟棄只能操作原始封包
   */
  _findOriginal(seq) {
    return this.snapshot?.packets.find(p => p.seq === seq && !p.isRetx);
  }

  _toggleSetValue(set, key) {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }
}

function _attemptKey(seq, attempt) {
  return `${seq}:${attempt}`;
}

// ── 建立全域單例 ──────────────────────────────────
const tcpSession = new TCPSession();

if (typeof window !== 'undefined') {
  window.TCPSession = TCPSession;
  window.tcpSession = tcpSession;
  window.RTT_UNIT   = RTT_UNIT;
  window.PROP_DELAY = SESSION_CONFIG.propDelay;
}
