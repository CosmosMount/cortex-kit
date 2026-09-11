(() => {
  const vscode = acquireVsCodeApi();
  const colors = ['#4fc1ff', '#f48771', '#b5cea8', '#c586c0', '#dcdcaa', '#9cdcfe', '#ce9178', '#569cd6'];
  let charts = []; let variables = new Map(); let session; let refreshRate = 30; let historySeconds = 30; let renderPending = false; let cursorTime; let arrangement = 'grid'; let draggedChartId;
  const histories = new Map();
  const chartsRoot = document.getElementById('charts'); const connection = document.getElementById('connection'); const metrics = document.getElementById('metrics'); const arrangementSelect = document.getElementById('arrangement');
  document.getElementById('add-chart').addEventListener('click', () => vscode.postMessage({ type: 'addChart' }));
  arrangementSelect.addEventListener('change', () => vscode.postMessage({ type: 'setArrangement', arrangement: arrangementSelect.value }));

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'snapshot') { charts = data.charts; arrangement = data.arrangement || 'grid'; setVariables(data.variables); session = data.state; refreshRate = data.refreshRate || 30; historySeconds = data.historySeconds || 30; rebuild(); updateHeader(); }
    if (data.type === 'clearHistory') { clearHistory(); }
    if (data.type === 'layout') { charts = data.charts; arrangement = data.arrangement || arrangement; rebuild(); }
    if (data.type === 'catalog') { setVariables(data.variables); rebuild(); }
    if (data.type === 'session') {
      if (session?.sessionId && data.state?.sessionId && session.sessionId !== data.state.sessionId) {
        clearHistory();
      }
      session = data.state; updateHeader();
    }
    if (data.type === 'samples') { append(data.batch); scheduleDraw(); }
    if (data.type === 'streamError') { metrics.textContent = data.message; }
  });
  window.addEventListener('resize', scheduleDraw);

  function setVariables(items) { variables = new Map((items || []).map(item => [item.id, item])); }
  function clearHistory() { histories.clear(); cursorTime = undefined; scheduleDraw(); }
  function updateHeader() {
    if (!session) { connection.textContent = 'No session'; return; }
    const target = typeof session.targetState === 'string' ? session.targetState : `halted · ${session.targetState.halted.reason}`;
    connection.textContent = `${session.chip || 'Cortex-M'} · ${target}`;
    metrics.textContent = `generation ${session.programGeneration} · stream ${session.streamEpoch} · dropped ${session.droppedFrames}`;
  }
  function rebuild() {
    chartsRoot.dataset.arrangement = arrangement;
    arrangementSelect.value = arrangement;
    chartsRoot.replaceChildren(...charts.map(buildChart)); scheduleDraw();
  }
  function buildChart(chart) {
    const root = element('section', 'chart'); root.dataset.chartId = chart.id;
    const toolbar = element('div', 'chart-toolbar');
    const drag = element('span', 'drag-handle'); drag.textContent = '⠿'; drag.title = 'Drag to reorder charts'; drag.draggable = true;
    drag.addEventListener('dragstart', event => { draggedChartId = chart.id; root.classList.add('dragging'); event.dataTransfer?.setData('text/plain', chart.id); if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; } });
    drag.addEventListener('dragend', () => { draggedChartId = undefined; root.classList.remove('dragging'); clearDropMarkers(); });
    root.addEventListener('dragover', event => { if (!draggedChartId || draggedChartId === chart.id) return; event.preventDefault(); clearDropMarkers(); root.classList.add(dropAfter(event, root) ? 'drop-after' : 'drop-before'); });
    root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) { root.classList.remove('drop-before', 'drop-after'); } });
    root.addEventListener('drop', event => { if (!draggedChartId || draggedChartId === chart.id) return; event.preventDefault(); const after = dropAfter(event, root); vscode.postMessage({ type: 'reorderCharts', sourceChartId: draggedChartId, targetChartId: chart.id, after }); clearDropMarkers(); });
    const title = element('input', 'chart-title'); title.value = chart.title; title.addEventListener('change', () => vscode.postMessage({ type: 'updateChart', chartId: chart.id, title: title.value }));
    const mode = element('select', 'secondary'); for (const [value, label] of [['time','Time'],['fft','FFT'],['both','Time + FFT']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === chart.mode; mode.append(option); } mode.addEventListener('change', () => vscode.postMessage({ type: 'updateChart', chartId: chart.id, mode: mode.value }));
    const add = button('＋ Variable', () => vscode.postMessage({ type: 'addVariables', chartId: chart.id }));
    const expression = button('fx', () => vscode.postMessage({ type: 'addExpression', chartId: chart.id }), 'secondary'); expression.title = 'Add expression';
    const remove = button('×', () => vscode.postMessage({ type: 'removeChart', chartId: chart.id }), 'secondary icon'); remove.title = 'Remove chart';
    toolbar.append(drag, title, mode, add, expression, remove);
    const legend = element('div', 'legend');
    chart.variableIds.forEach((id, index) => { const variable = variables.get(id); const chip = element('span', 'chip'); const swatch = element('span', 'swatch'); swatch.style.background = colors[index % colors.length]; const label = document.createTextNode(variable?.name || id); const close = button('×', () => vscode.postMessage({ type: 'removeVariable', chartId: chart.id, variableId: id })); chip.append(swatch, label, close); legend.append(chip); });
    const wrap = element('div', 'canvas-wrap'); const canvas = document.createElement('canvas'); canvas.dataset.chartId = chart.id; canvas.addEventListener('mousemove', event => { const rect = canvas.getBoundingClientRect(); const newest = newestTime(chart.variableIds); cursorTime = newest - historySeconds + event.offsetX / rect.width * historySeconds; scheduleDraw(); }); canvas.addEventListener('mouseleave', () => { cursorTime = undefined; scheduleDraw(); });
    wrap.append(canvas); if (!chart.variableIds.length) { const empty = element('div', 'empty'); empty.textContent = 'Use “＋ Variable” to add one or more signals'; wrap.append(empty); }
    root.append(toolbar, legend, wrap); return root;
  }
  function clearDropMarkers() { document.querySelectorAll('.chart.drop-before,.chart.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after')); }
  function dropAfter(event, target) { const rect = target.getBoundingClientRect(); if (arrangement === 'row') return event.clientX >= rect.left + rect.width / 2; if (arrangement === 'column') return event.clientY >= rect.top + rect.height / 2; const verticalOffset = event.clientY - rect.top; return verticalOffset > rect.height * .65 || (verticalOffset >= rect.height * .35 && event.clientX >= rect.left + rect.width / 2); }
  function append(batch) {
    const width = batch.channelIds.length;
    for (let channel = 0; channel < width; channel += 1) {
      const id = batch.channelIds[channel]; const history = histories.get(id) || [];
      for (let sample = 0; sample < batch.sampleCount; sample += 1) { history.push({ t: (batch.startTimestampNs + sample * batch.samplePeriodNs) / 1e9, v: batch.values[sample * width + channel], epoch: batch.streamEpoch }); }
      const cutoff = history.length ? history[history.length - 1].t - historySeconds : 0; let first = 0; while (first < history.length && history[first].t < cutoff) { first += 1; } if (first) { history.splice(0, first); }
      histories.set(id, history);
    }
    const actual = batch.samplePeriodNs ? 1e9 / batch.samplePeriodNs : 0; metrics.textContent = `${actual.toFixed(1)} S/s · ${batch.channelIds.length} variables · dropped ${batch.droppedFrames}`;
  }
  function scheduleDraw() { if (renderPending) return; renderPending = true; setTimeout(() => requestAnimationFrame(() => { renderPending = false; drawAll(); }), 1000 / refreshRate); }
  function drawAll() { document.querySelectorAll('canvas[data-chart-id]').forEach(canvas => { const chart = charts.find(item => item.id === canvas.dataset.chartId); if (chart) drawChart(canvas, chart); }); }
  function drawChart(canvas, chart) {
    const rect = canvas.getBoundingClientRect(); const ratio = devicePixelRatio || 1; canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio)); const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); const width = rect.width; const height = rect.height;
    const style = getComputedStyle(document.body); const grid = style.getPropertyValue('--vscode-editorWidget-border') || '#5558'; const text = style.getPropertyValue('--vscode-descriptionForeground') || '#aaa'; ctx.font = '11px ' + style.fontFamily;
    const timeHeight = chart.mode === 'both' ? height * .52 : height; const fftTop = chart.mode === 'both' ? timeHeight : 0;
    if (chart.mode !== 'fft') drawTime(ctx, chart, 36, 8, width - 44, timeHeight - 28, grid, text);
    if (chart.mode !== 'time') drawFft(ctx, chart, 36, fftTop + 8, width - 44, height - fftTop - 28, grid, text);
  }
  function drawTime(ctx, chart, x, y, width, height, grid, text) {
    axes(ctx, x, y, width, height, grid); const newest = newestTime(chart.variableIds); const start = newest - historySeconds; let all = [];
    chart.variableIds.forEach(id => { all = all.concat((histories.get(id) || []).filter(point => point.t >= start && point.t <= newest && Number.isFinite(point.v)).map(point => point.v)); });
    if (!all.length) {
      ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.fillText(waitingMessage(), x + width / 2, y + height / 2); ctx.textAlign = 'start';
      return;
    }
    const [min, max] = extent(all);
    chart.variableIds.forEach((id, index) => drawEnvelope(ctx, histories.get(id) || [], start, newest, min, max, x, y, width, height, colors[index % colors.length]));
    ctx.fillStyle = text; ctx.fillText(max.toPrecision(4), 2, y + 10); ctx.fillText(min.toPrecision(4), 2, y + height); ctx.fillText(`${historySeconds}s`, x, y + height + 16); ctx.fillText('now', x + width - 20, y + height + 16);
    if (cursorTime !== undefined && cursorTime >= start && cursorTime <= newest) { const cursorX = x + (cursorTime - start) / historySeconds * width; ctx.strokeStyle = text; ctx.beginPath(); ctx.moveTo(cursorX, y); ctx.lineTo(cursorX, y + height); ctx.stroke(); }
  }
  function drawEnvelope(ctx, points, start, end, min, max, x, y, width, height, color) {
    const bins = new Array(Math.max(1, Math.floor(width))); for (const point of points) { if (point.t < start || point.t > end || !Number.isFinite(point.v)) continue; const index = Math.min(bins.length - 1, Math.floor((point.t - start) / Math.max(Number.EPSILON, end - start) * bins.length)); const bin = bins[index]; bins[index] = bin && bin[2] === point.epoch ? [Math.min(bin[0], point.v), Math.max(bin[1], point.v), point.epoch] : [point.v, point.v, point.epoch]; }
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); let previousEpoch;
    bins.forEach((bin, index) => {
      if (!bin) { previousEpoch = undefined; return; }
      if (previousEpoch !== undefined && previousEpoch !== bin[2]) { previousEpoch = undefined; }
      const xx = x + index; const y1 = y + height - (bin[0] - min) / (max - min) * height; const y2 = y + height - (bin[1] - min) / (max - min) * height; const middle = (y1 + y2) / 2;
      if (previousEpoch !== undefined) ctx.lineTo(xx, middle); else ctx.moveTo(xx, middle);
      ctx.moveTo(xx, y1); ctx.lineTo(xx, y2); ctx.moveTo(xx, middle); ctx.fillRect(xx - 1, middle - 1, 2, 2); previousEpoch = bin[2];
    });
    ctx.stroke();
  }
  function drawFft(ctx, chart, x, y, width, height, grid, text) {
    axes(ctx, x, y, width, height, grid); let peak = 1;
    const spectra = chart.variableIds.map((id, colorIndex) => { const result = spectrum(histories.get(id) || []); return result ? { ...result, colorIndex } : undefined; }).filter(Boolean); spectra.forEach(result => result.values.forEach(value => peak = Math.max(peak, value)));
    if (!spectra.length) { ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.fillText(waitingMessage(), x + width / 2, y + height / 2); ctx.textAlign = 'start'; return; }
    spectra.forEach(result => { ctx.strokeStyle = colors[result.colorIndex % colors.length]; ctx.beginPath(); result.values.forEach((value, bin) => { const xx = x + bin / Math.max(1, result.values.length - 1) * width; const yy = y + height - value / peak * height; if (!bin) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }); ctx.stroke(); });
    const maxHz = spectra[0]?.maxHz || 0; ctx.fillStyle = text; ctx.fillText('FFT', 2, y + 10); ctx.fillText('0 Hz', x, y + height + 16); ctx.fillText(`${maxHz.toFixed(0)} Hz`, x + width - 42, y + height + 16);
  }
  function spectrum(points) {
    const epoch = points.at(-1)?.epoch; const source = points.filter(point => point.epoch === epoch && Number.isFinite(point.v)).slice(-65536); let n = 1; while (n * 2 <= source.length && n < 65536) n *= 2; if (n < 16) return undefined; const selected = source.slice(-n); const input = selected.map(point => point.v); const output = fftMagnitudes(input); const period=(selected[selected.length-1].t-selected[0].t)/(n-1); return period > 0 ? { values: output, maxHz: 1/(2*period) } : undefined;
  }
  function fftMagnitudes(input) {
    const n=input.length, real=new Float64Array(n), imag=new Float64Array(n); const mean=input.reduce((a,b)=>a+b,0)/n; let windowSum=0;
    for(let i=0;i<n;i+=1){const weight=.5-.5*Math.cos(2*Math.PI*i/(n-1));real[i]=(input[i]-mean)*weight;windowSum+=weight;}
    for(let i=1,j=0;i<n;i+=1){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];[imag[i],imag[j]]=[imag[j],imag[i]];}}
    for(let width=2;width<=n;width*=2){const angle=-2*Math.PI/width;for(let start=0;start<n;start+=width){for(let offset=0;offset<width/2;offset+=1){const phase=angle*offset,wr=Math.cos(phase),wi=Math.sin(phase),right=start+offset+width/2,left=start+offset;const tr=real[right]*wr-imag[right]*wi,ti=real[right]*wi+imag[right]*wr,lr=real[left],li=imag[left];real[left]=lr+tr;imag[left]=li+ti;real[right]=lr-tr;imag[right]=li-ti;}}}
    return Array.from({length:n/2},(_,index)=>Math.hypot(real[index],imag[index])*(index===0?1:2)/windowSum);
  }
  function axes(ctx, x, y, width, height, color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); for (let i=0;i<=4;i+=1) { const yy=y+i/4*height; ctx.moveTo(x,yy); ctx.lineTo(x+width,yy); } ctx.stroke(); }
  function extent(values) { if (!values.length) return [-1,1]; let min=Infinity, max=-Infinity; for (const value of values) { if (value < min) min = value; if (value > max) max = value; } if (min===max) { const delta=Math.max(1,Math.abs(min)*.05); min-=delta; max+=delta; } const pad=(max-min)*.06; return [min-pad,max+pad]; }
  function waitingMessage() { const state=session?.targetState; const halted=typeof state==='object' && state?.halted; return halted ? 'Target halted — press Continue to start sampling' : 'Waiting for samples…'; }
  function newestTime(ids) { return ids.reduce((latest,id) => Math.max(latest, histories.get(id)?.at(-1)?.t || 0), 0); }
  function element(tag, className) { const node=document.createElement(tag); if(className) node.className=className; return node; }
  function button(label, action, className='') { const node=element('button',className); node.textContent=label; node.addEventListener('click',action); return node; }
  vscode.postMessage({ type: 'ready' });
})();
