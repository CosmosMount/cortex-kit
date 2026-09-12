(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const colors = ['#50b9ef', '#eeac64', '#9dd787', '#d392ed', '#ed7c8a', '#61d1bc', '#b8b9ff', '#d8cb75'];
  const canvas = el('chart'), ctx = canvas.getContext('2d');
  let state = {}, curves = [], hidden = new Set(), range, fullRange, cursor, dragging, live = false, scheduled = false, requestTimer;
  let signature = '', importSignature = '', settingsInitialized = false;
  const padding = { left: 76, right: 24, top: 24, bottom: 42 };
  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  el('select').onclick = () => send('select');
  el('start').onclick = () => send('start', { rate: Number(el('rate').value), duration: Number(el('duration').value) });
  el('stop').onclick = () => send('stop');
  el('import').onclick = () => send('import');
  el('reveal').onclick = () => send('reveal');
  el('fit').onclick = () => { range = fullRange?.slice(); el('follow').checked = true; if (state.imported) { requestView(false); } drawSoon(); };
  el('follow').onchange = () => { if (el('follow').checked) { range = fullRange?.slice(); drawSoon(); } };
  el('columns').onclick = () => { el('column-picker').hidden = !el('column-picker').hidden; };
  el('time-column').onchange = () => { el('follow').checked = true; requestView(false); };
  el('unit').onchange = () => { el('follow').checked = true; requestView(false); };

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') { state = data; updateState(); }
    if (data.type === 'clear') { curves = []; signature = ''; hidden.clear(); range = fullRange = cursor = undefined; el('tooltip').hidden = true; el('follow').checked = true; el('legend').replaceChildren(); drawSoon(); }
    if (data.type === 'curves') {
      curves = data.curves; live = data.live;
      const bounds = boundsOf(curves);
      if (!data.preserveRange && bounds) {
        fullRange = bounds;
        if (!range || el('follow').checked || !live) { range = fullRange.slice(); }
      }
      const nextSignature = curves.map(curve => curve.name).join('\u0000');
      if (signature !== nextSignature) { signature = nextSignature; buildLegend(); }
      el('plot-title').textContent = live ? '实时预览 · 最近 4000 个样本' : 'CSV 时间序列';
      drawSoon();
    }
  });
  function updateState() {
    const locked = state.recording || state.busy;
    for (const id of ['select', 'start', 'import', 'rate', 'duration']) { el(id).disabled = locked; }
    el('stop').disabled = !state.recording;
    el('reveal').disabled = !state.file;
    el('connection').textContent = state.recording ? '● 正在记录' : state.connected ? '目标已连接' : '离线 · 可导入 CSV';
    el('connection').classList.toggle('connected', !!state.connected);
    el('selected-count').textContent = state.selected?.length ?? 0;
    el('selected').textContent = state.selected?.length ? state.selected.join('  ·  ') : '尚未选择采样变量';
    el('selected').title = state.selected?.join('\n') ?? '';
    if (!settingsInitialized || state.recording) { el('rate').value = state.requestedHz; el('duration').value = state.durationSeconds; settingsInitialized = true; }
    el('actual').textContent = state.actualHz ? `${state.actualHz.toFixed(1)} S/s` : '—';
    el('rows').textContent = (state.imported?.rows ?? state.rows ?? 0).toLocaleString();
    el('elapsed').textContent = `${(state.elapsedSeconds ?? 0).toFixed(3)} s`;
    el('dropped').textContent = (state.dropped ?? 0).toLocaleString();
    el('file').textContent = state.file || '尚未选择文件';
    el('status').textContent = state.status;
    el('status').classList.toggle('error', !!state.error);
    el('csv-controls').hidden = !state.imported;
    if (!state.imported) { el('column-picker').hidden = true; importSignature = ''; }
    else {
      const key = JSON.stringify([state.file, state.imported.headers]);
      if (key !== importSignature) {
        importSignature = key;
        el('time-column').replaceChildren(...state.imported.headers.map((name, index) => {
          const option = document.createElement('option'); option.textContent = name; option.value = index; return option;
        }));
        el('time-column').value = state.imported.timeColumn;
        el('unit').value = String(state.imported.scale);
        el('column-picker').replaceChildren(...state.imported.headers.map((name, index) => {
          const label = document.createElement('label'), input = document.createElement('input');
          input.type = 'checkbox'; input.value = index; input.checked = state.imported.columns.includes(index);
          input.onchange = () => requestView(false); label.append(input, document.createTextNode(name)); return label;
        }));
      }
    }
  }
  function requestView(zoom) {
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => send('view', { timeColumn: Number(el('time-column').value), scale: Number(el('unit').value),
      columns: [...el('column-picker').querySelectorAll('input:checked')].map(input => Number(input.value)), ...(zoom ? { range } : {}) }), zoom ? 100 : 0);
  }
  function boundsOf(items) {
    let min = Infinity, max = -Infinity;
    for (const curve of items) { if (curve.points.length) { min = Math.min(min, curve.points[0][0]); max = Math.max(max, curve.points.at(-1)[0]); } }
    return Number.isFinite(min) ? [min, max > min ? max : min + .01] : undefined;
  }
  function buildLegend() {
    el('legend').replaceChildren(...curves.map((curve, index) => {
      const button = document.createElement('button'), swatch = document.createElement('span');
      swatch.className = 'swatch'; swatch.style.background = colors[index % colors.length];
      button.append(swatch, document.createTextNode(curve.name)); button.classList.toggle('muted', hidden.has(curve.name));
      button.onclick = () => { if (hidden.has(curve.name)) { hidden.delete(curve.name); } else { hidden.add(curve.name); } button.classList.toggle('muted', hidden.has(curve.name)); drawSoon(); };
      return button;
    }));
  }
  function drawSoon() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; draw(); }); } }
  function draw() {
    const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = rect.width - padding.left - padding.right, height = rect.height - padding.top - padding.bottom;
    const styles = getComputedStyle(document.body), foreground = styles.color;
    ctx.clearRect(0, 0, rect.width, rect.height);
    el('empty').hidden = !!curves.some(curve => curve.points.length);
    if (width <= 0 || height <= 0 || !range) { return; }
    let low = Infinity, high = -Infinity;
    for (const curve of curves) {
      if (hidden.has(curve.name)) { continue; }
      for (const [time, value] of curve.points) { if (time >= range[0] && time <= range[1] && value !== null) { low = Math.min(low, value); high = Math.max(high, value); } }
    }
    if (!Number.isFinite(low)) { low = -1; high = 1; }
    const margin = (high - low || Math.max(1, Math.abs(low) * .1)) * .08;
    low -= margin; high += margin;
    const x = time => padding.left + (time - range[0]) / (range[1] - range[0]) * width;
    const y = value => padding.top + (high - value) / (high - low) * height;
    ctx.font = '11px system-ui'; ctx.lineWidth = 1; ctx.fillStyle = foreground;
    for (let i = 0; i <= 5; i++) {
      const px = padding.left + width * i / 5, py = padding.top + height * i / 5;
      ctx.strokeStyle = foreground; ctx.globalAlpha = .10; ctx.beginPath(); ctx.moveTo(px, padding.top); ctx.lineTo(px, padding.top + height); ctx.moveTo(padding.left, py); ctx.lineTo(padding.left + width, py); ctx.stroke();
      ctx.globalAlpha = .7; ctx.textAlign = 'center'; ctx.fillText(format(range[0] + (range[1] - range[0]) * i / 5), px, padding.top + height + 24);
      ctx.textAlign = 'right'; ctx.fillText(format(high - (high - low) * i / 5), padding.left - 10, py + 4);
    }
    ctx.globalAlpha = 1; ctx.save(); ctx.beginPath(); ctx.rect(padding.left, padding.top, width, height); ctx.clip();
    curves.forEach((curve, index) => {
      if (hidden.has(curve.name)) { return; }
      ctx.strokeStyle = colors[index % colors.length]; ctx.lineWidth = 1.4; ctx.beginPath(); let pen = false;
      for (const [time, value] of curve.points) {
        if (value === null) { pen = false; continue; }
        if (!pen) { ctx.moveTo(x(time), y(value)); pen = true; } else { ctx.lineTo(x(time), y(value)); }
      }
      ctx.stroke();
    });
    if (cursor !== undefined) { ctx.strokeStyle = foreground; ctx.globalAlpha = .5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x(cursor), padding.top); ctx.lineTo(x(cursor), padding.top + height); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1; ctx.setLineDash([]);
    el('range').textContent = `时间 / s    ${format(range[0])} — ${format(range[1])}`;
  }
  function format(value) { return value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < .001) ? value.toExponential(3) : Number(value.toPrecision(6)).toString(); }
  function pointerTime(event) {
    const width = canvas.getBoundingClientRect().width - padding.left - padding.right;
    return range[0] + Math.max(0, Math.min(1, (event.offsetX - padding.left) / width)) * (range[1] - range[0]);
  }
  canvas.addEventListener('wheel', event => {
    if (!range) { return; } event.preventDefault();
    const center = pointerTime(event), factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * .002)));
    const left = center - (center - range[0]) * factor, right = center + (range[1] - center) * factor;
    if (right - left > 1e-9) { range = [left, right]; el('follow').checked = false; if (state.imported) { requestView(true); } drawSoon(); }
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (range) { dragging = { x: event.clientX, range: range.slice() }; canvas.setPointerCapture(event.pointerId); el('follow').checked = false; } });
  canvas.addEventListener('pointerup', () => { dragging = undefined; if (state.imported) { requestView(true); } });
  canvas.addEventListener('pointercancel', () => { dragging = undefined; });
  canvas.addEventListener('pointerleave', () => { if (!dragging) { cursor = undefined; el('tooltip').hidden = true; drawSoon(); } });
  canvas.addEventListener('pointermove', event => {
    if (!range) { return; }
    if (dragging) {
      const width = canvas.getBoundingClientRect().width - padding.left - padding.right;
      const shift = (event.clientX - dragging.x) / width * (dragging.range[1] - dragging.range[0]);
      range = dragging.range.map(value => value - shift); drawSoon(); return;
    }
    cursor = pointerTime(event);
    const lines = [`${format(cursor)} s`];
    for (const curve of curves) {
      if (hidden.has(curve.name) || !curve.points.length) { continue; }
      let lo = 0, hi = curve.points.length - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (curve.points[mid][0] < cursor) { lo = mid + 1; } else { hi = mid; } }
      if (lo > 0 && Math.abs(curve.points[lo - 1][0] - cursor) < Math.abs(curve.points[lo][0] - cursor)) { lo--; }
      const [time, value] = curve.points[lo];
      lines.push(`${curve.name}: ${value === null ? '—' : format(value)}  (${format(time)} s)`);
    }
    const tip = el('tooltip'); tip.replaceChildren(...lines.slice(0, 12).map(text => { const line = document.createElement('div'); line.textContent = text; return line; }));
    tip.hidden = false; tip.style.left = `${Math.max(8, Math.min(event.offsetX + 18, canvas.clientWidth - 330))}px`; tip.style.top = `${Math.max(8, Math.min(event.offsetY + 15, canvas.clientHeight - 160))}px`; drawSoon();
  });
  new ResizeObserver(drawSoon).observe(canvas.parentElement);
  window.addEventListener('resize', drawSoon);
  send('ready');
})();
