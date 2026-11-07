/**
 * CwndChart — 使用 Canvas 繪製 cwnd 與 ssthresh 歷史折線圖
 * 不依賴外部圖表庫，純手刻 Canvas 2D。
 */

'use strict';

class CwndChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 340;
    const h = rect.height || 220;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
  }

  draw(history, time = null) {
    const ctx = this.ctx;
    const W = this._w;
    const H = this._h;

    // ── 清除 ──
    ctx.clearRect(0, 0, W, H);

    // ── 背景 ──
    ctx.fillStyle = '#f7f9fc';
    ctx.beginPath();
    this._roundRect(ctx, 0, 0, W, H, 8);
    ctx.fill();

    if (!history || history.length < 1) return;

    // ── Padding ──
    const pad = { top: 24, right: 20, bottom: 36, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // ── Y 軸範圍 ──
    const maxVal = Math.max(...history.map(h => Math.max(h.cwnd, h.ssthresh)), 10);
    const yMax = Math.ceil(maxVal / 2) * 2 + 2;

    const xScale = n => pad.left + (n / (history.length - 1 || 1)) * plotW;
    const yScale = v => pad.top + plotH - (v / yMax) * plotH;
    let activeIndex = 0;
    if (time === null || time === undefined) {
      activeIndex = history.length - 1;
    } else {
      for (let i = 0; i < history.length; i++) {
        if ((history[i].time ?? 0) > time) break;
        activeIndex = i;
      }
    }

    // ── 格線 ──
    ctx.strokeStyle = 'rgba(93,109,133,.15)';
    ctx.lineWidth = 1;
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const v = (yMax / gridSteps) * i;
      const y = yScale(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      // Y 軸標籤
      ctx.fillStyle = 'rgba(80,96,120,.72)';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(v), pad.left - 6, y);
    }

    // X 軸刻度（每隔 N 個點）
    ctx.fillStyle = 'rgba(80,96,120,.72)';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const tickEvery = Math.max(1, Math.floor(history.length / 8));
    for (let i = 0; i < history.length; i += tickEvery) {
      const x = xScale(i);
      ctx.fillText(i, x, pad.top + plotH + 14);
    }

    // X 軸標題
    ctx.fillStyle = 'rgba(80,96,120,.5)';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Events', pad.left + plotW / 2, H - 4);

    // Y 軸標題
    ctx.save();
    ctx.translate(10, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(80,96,120,.5)';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('MSS', 0, 0);
    ctx.restore();

    // ── ssthresh 線（橘色虛線）──
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    history.forEach((pt, i) => {
      const x = xScale(i);
      const y = yScale(pt.ssthresh);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // ── cwnd 線（藍色實線）──
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    history.forEach((pt, i) => {
      const x = xScale(i);
      const y = yScale(pt.cwnd);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // ── cwnd 填色區域 ──
    ctx.save();
    ctx.beginPath();
    history.forEach((pt, i) => {
      const x = xScale(i);
      const y = yScale(pt.cwnd);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(xScale(history.length - 1), yScale(0));
    ctx.lineTo(xScale(0), yScale(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(59,130,246,.25)');
    grad.addColorStop(1, 'rgba(59,130,246,.03)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // ── 資料點 ──
    history.forEach((pt, i) => {
      const x = xScale(i);
      // cwnd 點
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(x, yScale(pt.cwnd), 3.5, 0, Math.PI * 2);
      ctx.fill();
      // ssthresh 點
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(x, yScale(pt.ssthresh), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // 垂直線標示滑鼠所檢視的時間點。
    const activeX = xScale(activeIndex);
    ctx.save();
    ctx.strokeStyle = 'rgba(39,56,79,.55)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(activeX, pad.top); ctx.lineTo(activeX, pad.top + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

window.CwndChart = CwndChart;

