/* Display-only renderer. In native mode this file owns no raw sample history. */
(function (root) {
  'use strict';
  function axes(ctx, x, y, width, height, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i <= 4; i++) { const yy = y + i * height / 4; ctx.moveTo(x, yy); ctx.lineTo(x + width, yy); } ctx.stroke();
  }
  function range(series, field) {
    let low = Infinity, high = -Infinity;
    for (const item of series) { const e = field(item); if (!e) continue;
      if (Number.isFinite(e.low)) low = Math.min(low, e.low);
      if (Number.isFinite(e.high)) high = Math.max(high, e.high);
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
    if (low === high) { const delta = Math.max(1, Math.abs(low) * .05); low -= delta; high += delta; }
    const pad = (high - low) * .06; return [low - pad, high + pad];
  }
  function drawBins(ctx, bins, low, high, x, y, width, height, color, frequency = false) {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); let previous;
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      if (!bin || !Number.isFinite(bin[0]) || !Number.isFinite(bin[1])) { previous = undefined; continue; }
      const xx = x + i * width / Math.max(1, bins.length - (frequency ? 1 : 0));
      const a = y + height - (bin[0] - low) / (high - low) * height;
      const b = y + height - (bin[1] - low) / (high - low) * height;
      const middle = (a + b) / 2;
      if (bin[2] < 0) { ctx.fillRect(xx - 1, a - 1, 2, 2); ctx.fillRect(xx - 1, b - 1, 2, 2); previous = undefined; continue; }
      if (previous === bin[2]) ctx.lineTo(xx, middle); else ctx.moveTo(xx, middle);
      ctx.moveTo(xx, a); ctx.lineTo(xx, b); ctx.moveTo(xx, middle);
      if (a === b) ctx.fillRect(xx - 1, a - 1, 2, 2); previous = bin[2];
    }
    ctx.stroke();
  }
  class NativePlot {
    constructor(options) {
      this.options = options; this.active = false; this.frames = new Map();
      this.pending = undefined; this.nextId = 1; this.version = 0; this.exporting = false;
      this.lastRequest = -Infinity; this.retryAfter = 0; this.lastError = '';
      this.interval = setInterval(() => this.tick(), 16);
    }
    setEnabled(enabled) { if (this.active !== enabled) { this.active = enabled; this.clear(); } }
    clear() { this.frames.clear(); this.version++; this.options.redraw(); }
    invalidate() { this.version++; this.lastRequest = -Infinity; }
    hasData(chart) { return !!this.chart(chart.id)?.series?.some(series => series.count > 0 && chart.variableIds.includes(series.id)); }
    chart(id) { return (this.exportFrames || this.frames).get(id); }
    newest(ids) {
      let latest = 0;
      for (const chart of (this.exportFrames || this.frames).values()) if (chart.series.some(s => ids.includes(s.id))) latest = Math.max(latest, chart.end);
      return latest;
    }
    receive(message) {
      if (message.type !== 'nativeFrame') return false;
      const pending = this.pending;
      if (!pending || message.requestId !== pending.id) return true;
      this.pending = undefined; clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error)));
      else if (pending.version !== this.version) pending.reject(new Error('Native viewport changed during request'));
      else if (!message.frame || !Array.isArray(message.frame.charts)) pending.reject(new Error('Invalid native display response'));
      else pending.resolve(message.frame);
      return true;
    }
    request(viewports) {
      if (this.pending) return Promise.reject(new Error('Native display has one request credit'));
      if (!Array.isArray(viewports) || viewports.length > 32) return Promise.reject(new Error('Too many native viewports'));
      const id = `native-${this.nextId++}`;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (this.pending?.id === id) { this.pending = undefined; reject(new Error('Native display response timed out')); } }, 12000);
        this.pending = { id, version: this.version, resolve, reject, timer };
      });
      this.pending.promise = promise;
      this.options.post({ type: 'nativeRender', requestId: id, viewports });
      return promise;
    }
    tick() {
      if (!this.active || this.pending || this.exporting || this.options.hidden()) return;
      const now = performance.now(), interval = 1000 / Math.max(1, Math.min(60, this.options.refreshRate()));
      if (now < this.retryAfter || now - this.lastRequest < interval - .5) return;
      const viewports = this.options.viewports(); if (!viewports.length) return;
      this.lastRequest = now;
      void this.request(viewports).then(frame => {
        this.frames = new Map(frame.charts.map(chart => [chart.id, chart]));
        this.lastError = ''; this.options.metrics(`Rust · display drops ${frame.displayDroppedFrames} · history evictions ${frame.historyEvictions}${frame.resolutionClamped ? ' · pixel budget limited' : ''}${frame.errors?.length ? ` · ${frame.errors.join('; ')}` : ''}`);
        this.options.redraw();
      }).catch(error => { this.lastError = String(error); this.retryAfter = performance.now() + 500; this.options.metrics(this.lastError); });
    }
    async export(ids, render) {
      if (this.exporting) throw new Error('Native export is already running');
      this.exporting = true;
      try {
        if (this.pending) { try { await this.pending.promise; } catch { /* Request new coherent snapshot below. */ } }
        const version = this.version;
        const frame = await this.request(ids.map(id => ({ id, columns: 1536 })));
        if (version !== this.version) throw new Error('Target/layout changed during export');
        this.exportFrames = new Map(frame.charts.map(chart => [chart.id, chart]));
        return render();
      } finally { this.exportFrames = undefined; this.exporting = false; this.options.redraw(); }
    }
    time(ctx, chart, x, y, width, height, grid, text, relative, cursor) {
      axes(ctx, x, y, width, height, grid); const frame = this.chart(chart.id);
      const bounds = range(frame?.series || [], s => s.time);
      if (!bounds) { this.waiting(ctx, x, y, width, height, text); return; }
      const byId = new Map(frame.series.map(s => [s.id, s]));
      chart.variableIds.forEach((id, index) => {
        const envelope = byId.get(id)?.time;
        if (envelope) drawBins(ctx, envelope.bins, ...bounds, x, y, width, height, this.options.colors[index % this.options.colors.length]);
      });
      ctx.fillStyle = text; ctx.fillText(bounds[1].toPrecision(4), Math.max(2, x - 65), y + 10);
      ctx.fillText(bounds[0].toPrecision(4), Math.max(2, x - 65), y + height);
      ctx.fillText(`${relative ? '-' : ''}${(frame.end - frame.start).toFixed(1)} s`, x, y + height + 16);
      ctx.fillText(relative ? '0 s' : 'now', x + width - 20, y + height + 16);
      if (Number.isFinite(cursor) && cursor >= frame.start && cursor <= frame.end) {
        const xx = x + (cursor - frame.start) / (frame.end - frame.start) * width;
        ctx.strokeStyle = text; ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + height); ctx.stroke();
      }
    }
    fft(ctx, chart, x, y, width, height, grid, text) {
      axes(ctx, x, y, width, height, grid); const frame = this.chart(chart.id);
      const spectra = frame?.series.filter(s => s.fft) || [];
      if (!spectra.length) { this.waiting(ctx, x, y, width, height, text); return; }
      const peak = Math.max(1, ...spectra.map(s => s.fft.envelope.high || 0));
      const byId = new Map(spectra.map(s => [s.id, s]));
      chart.variableIds.forEach((id, index) => { const s = byId.get(id); if (s) drawBins(ctx, s.fft.envelope.bins, 0, peak, x, y, width, height, this.options.colors[index % this.options.colors.length], true); });
      ctx.fillStyle = text; ctx.fillText('FFT', Math.max(2, x - 65), y + 10); ctx.fillText('0 Hz', x, y + height + 16);
      ctx.fillText(`${spectra[0].fft.maxHz.toFixed(0)} Hz`, x + width - 48, y + height + 16);
    }
    waiting(ctx, x, y, width, height, text) {
      ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.fillText(this.lastError || 'Waiting for native snapshot…', x + width / 2, y + height / 2); ctx.textAlign = 'start';
    }
    dispose() {
      clearInterval(this.interval); this.active = false;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Native plot disposed')); this.pending = undefined; }
    }
  }
  const api = { NativePlot, drawBins };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CortexKitNativePlot = api;
})(globalThis);
