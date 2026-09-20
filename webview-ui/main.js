(() => {
  const vscode = acquireVsCodeApi();
  const colors = ['#4fc1ff', '#f48771', '#b5cea8', '#c586c0', '#dcdcaa', '#9cdcfe', '#ce9178', '#569cd6'];
  let charts = []; let variables = new Map(); let session; let refreshRate = 30; let historySeconds = 30; let renderPending = false; let cursorTime; let arrangement = 'grid'; let draggedChartId;
  const nativeOptions = {
    post: message => vscode.postMessage(message), redraw: () => scheduleDraw(), colors,
    refreshRate: () => refreshRate, hidden: () => document.hidden,
    metrics: message => { metrics.textContent = message; },
    viewports: () => [...document.querySelectorAll('canvas[data-chart-id]')].flatMap(canvas => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return [];
      return [{ id: canvas.dataset.chartId, columns: Math.max(1, Math.min(4096, Math.ceil((rect.width - 44) * (devicePixelRatio || 1)))) }];
    }),
  };
  const NativePlot = globalThis.CortexKitNativePlot?.NativePlot;
  if (!NativePlot) throw new Error('Rust Plot renderer is missing; rebuild the extension media');
  const native = new NativePlot(nativeOptions);
  native.setEnabled(true);
  const chartsRoot = document.getElementById('charts'); const connection = document.getElementById('connection'); const metrics = document.getElementById('metrics'); const arrangementSelect = document.getElementById('arrangement');
  document.getElementById('add-chart').addEventListener('click', () => vscode.postMessage({ type: 'addChart' }));
  document.getElementById('export-plots').addEventListener('click', () => vscode.postMessage({ type: 'exportPlots' }));
  arrangementSelect.addEventListener('change', () => vscode.postMessage({ type: 'setArrangement', arrangement: arrangementSelect.value }));
  const historySelect = document.getElementById('history-seconds');
  historySelect.addEventListener('change', () => vscode.postMessage({ type: 'setHistorySeconds', seconds: historySelect.value === 'custom' ? 'custom' : Number(historySelect.value) }));

  window.addEventListener('message', ({ data }) => {
    if (native.receive(data)) return;
    if (data.type === 'nativeRefresh') native.invalidate();
    if (data.type === 'historyWindow' && Number.isFinite(data.refreshRate)) refreshRate = data.refreshRate;
    if (['snapshot', 'layout', 'catalog', 'historyWindow'].includes(data.type)) native.invalidate();
    if (data.type === 'snapshot') { charts = data.charts; arrangement = data.arrangement || 'grid'; setVariables(data.variables); session = data.state; refreshRate = data.refreshRate || 30; setHistoryWindow(data.historySeconds); rebuild(); updateHeader(); }
    if (data.type === 'historyWindow') { setHistoryWindow(data.historySeconds); }
    if (data.type === 'renderExport') {
      void native.export(data.chartIds, () => exportPlots(data.chartIds)).then(dataUrl => vscode.postMessage({ type: 'exportImage', requestId: data.requestId, dataUrl }),
        error => vscode.postMessage({ type: 'exportImage', requestId: data.requestId, error: String(error) }));
    }
    if (data.type === 'clearHistory') { clearHistory(); }
    if (data.type === 'layout') { charts = data.charts; arrangement = data.arrangement || arrangement; rebuild(); }
    if (data.type === 'catalog') { setVariables(data.variables); rebuild(); }
    if (data.type === 'session') {
      if (session?.sessionId && data.state?.sessionId && session.sessionId !== data.state.sessionId) {
        clearHistory();
      }
      session = data.state; updateHeader();
    }
    if (data.type === 'streamError') { metrics.textContent = data.message; }
  });
  window.addEventListener('resize', () => { native.invalidate(); scheduleDraw(); });
  document.addEventListener?.('visibilitychange', () => { if (!document.hidden) { native.invalidate(); scheduleDraw(); } });

  function setVariables(items) { variables = new Map((items || []).map(item => [item.id, item])); }
  function setHistoryWindow(seconds) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) { return; }
    historySeconds = seconds;
    const preset = [5, 10, 30, 60, 120, 300, 600].includes(seconds);
    historySelect.querySelector('option[value="custom"]').textContent = preset ? '自定义…' : `自定义：${seconds} 秒`;
    historySelect.value = preset ? String(seconds) : 'custom';
    cursorTime = undefined;
    scheduleDraw();
  }
  function clearHistory() { native.clear(); cursorTime = undefined; scheduleDraw(); }
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
    const wrap = element('div', 'canvas-wrap'); const canvas = document.createElement('canvas'); canvas.dataset.chartId = chart.id; canvas.addEventListener('mousemove', event => { const rect = canvas.getBoundingClientRect(); const newest = newestTime(chart.variableIds); cursorTime = newest - historySeconds + Math.max(0, Math.min(1, (event.offsetX - 36) / Math.max(1, rect.width - 44))) * historySeconds; scheduleDraw(); }); canvas.addEventListener('mouseleave', () => { cursorTime = undefined; scheduleDraw(); });
    wrap.append(canvas); if (!chart.variableIds.length) { const empty = element('div', 'empty'); empty.textContent = 'Use “＋ Variable” to add one or more signals'; wrap.append(empty); }
    root.append(toolbar, legend, wrap); return root;
  }
  function clearDropMarkers() { document.querySelectorAll('.chart.drop-before,.chart.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after')); }
  function dropAfter(event, target) { const rect = target.getBoundingClientRect(); if (arrangement === 'row') return event.clientX >= rect.left + rect.width / 2; if (arrangement === 'column') return event.clientY >= rect.top + rect.height / 2; const verticalOffset = event.clientY - rect.top; return verticalOffset > rect.height * .65 || (verticalOffset >= rect.height * .35 && event.clientX >= rect.left + rect.width / 2); }
  let lastNativeDraw = -Infinity;
  function scheduleDraw() {
    if (renderPending || document.hidden) return;
    renderPending = true;
    const draw = now => {
      if (document.hidden) { renderPending = false; return; }
      if (now - lastNativeDraw < 1000 / Math.max(1, Math.min(60, refreshRate)) - .5) { requestAnimationFrame(draw); return; }
      renderPending = false; lastNativeDraw = now; drawAll();
    };
    requestAnimationFrame(draw);
  }
  function drawAll() {
    const byId = new Map(charts.map(chart => [chart.id, chart]));
    document.querySelectorAll('canvas[data-chart-id]').forEach(canvas => {
      const chart = byId.get(canvas.dataset.chartId), rect = canvas.getBoundingClientRect();
      if (chart && rect.width && rect.height && rect.bottom >= 0 && rect.top <= innerHeight && rect.right >= 0 && rect.left <= innerWidth) drawChart(canvas, chart);
    });
  }
  function drawChart(canvas, chart) {
    const rect = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * ratio)), h = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = rect.width, height = rect.height;
    const style = getComputedStyle(document.body), grid = style.getPropertyValue('--vscode-editorWidget-border') || '#5558', text = style.getPropertyValue('--vscode-descriptionForeground') || '#aaa';
    ctx.font = '11px ' + style.fontFamily;
    const timeHeight = chart.mode === 'both' ? height * .52 : height, fftTop = chart.mode === 'both' ? timeHeight : 0;
    if (width <= 44 || height <= 28) return;
    if (chart.mode !== 'fft') drawTime(ctx, chart, 36, 8, width - 44, timeHeight - 28, grid, text);
    if (chart.mode !== 'time') drawFft(ctx, chart, 36, fftTop + 8, width - 44, height - fftTop - 28, grid, text);
  }
  function exportPlots(ids) {
    const selected = charts.filter(chart => ids.includes(chart.id));
    if (!selected.length) { throw new Error('没有选中图表。'); }
    if (selected.some(chart => !native.hasData(chart))) { throw new Error('所选图表的数据已清空，请重新采样后导出。'); }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const width = 900, margin = 28, scale = 2;
    const style = getComputedStyle(document.body);
    const background = style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
    const foreground = style.getPropertyValue('--vscode-editor-foreground').trim() || '#dddddd';
    const grid = style.getPropertyValue('--vscode-editorWidget-border').trim() || '#555555';
    const font = style.fontFamily || 'sans-serif';
    ctx.font = `13px ${font}`;
    const sections = selected.map(chart => {
      const legend = chart.variableIds.flatMap((id, index) => wrapText(ctx, variables.get(id)?.expression || variables.get(id)?.name || id, width - margin * 2 - 22).map((text, line) => ({ text, color: colors[index % colors.length], first: line === 0 })));
      ctx.font = `bold 18px ${font}`;
      const titles = wrapText(ctx, chart.title, width - margin * 2 - 20);
      ctx.font = `13px ${font}`;
      const plotHeight = chart.mode === 'both' ? 480 : 280;
      return { chart, legend, titles, plotHeight, height: titles.length * 24 + 28 + legend.length * 19 + plotHeight + 30 };
    });
    const height = 90 + sections.reduce((sum, section) => sum + section.height, 0);
    if (height * scale > 16000 || width * height * scale * scale > 30_000_000) { throw new Error('合并图片尺寸过大，请减少图表或变量数量后重试。'); }
    canvas.width = width * scale; canvas.height = height * scale; ctx.scale(scale, scale);
    ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = foreground; ctx.font = `bold 23px ${font}`; ctx.fillText('Cortex Kit · Plot', margin, 34);
    ctx.font = `12px ${font}`; ctx.fillText(`Time window: ${historySeconds} s  |  ${new Date().toISOString()}`, margin, 58);
    let top = 86;
    const previousCursor = cursorTime; cursorTime = undefined;
    try {
      for (const section of sections) {
        const { chart, legend, titles, plotHeight } = section;
        ctx.fillStyle = foreground; ctx.font = `bold 18px ${font}`;
        titles.forEach((title, index) => ctx.fillText(title, margin, top + 18 + index * 24));
        let y = top + titles.length * 24;
        ctx.font = `12px ${font}`;
        ctx.fillText(`${chart.mode === 'both' ? 'Time + FFT' : chart.mode === 'fft' ? 'FFT' : 'Time'}  |  ${chart.mode === 'fft' ? 'Frequency axis: Hz' : 'Time axis relative to last sample'}`, margin, y + 17);
        y += 28; ctx.font = `13px ${font}`;
        for (const item of legend) {
          if (item.first) { ctx.fillStyle = item.color; ctx.fillRect(margin, y + 3, 10, 10); }
          ctx.fillStyle = foreground; ctx.fillText(item.text, margin + 20, y + 13); y += 19;
        }
        ctx.font = `11px ${font}`;
        const timeHeight = chart.mode === 'both' ? plotHeight / 2 : plotHeight;
        if (chart.mode !== 'fft') { drawTime(ctx, chart, margin + 70, y + 12, width - 2 * margin - 80, timeHeight - 40, grid, foreground, true); }
        if (chart.mode !== 'time') { drawFft(ctx, chart, margin + 70, y + (chart.mode === 'both' ? timeHeight : 0) + 12, width - 2 * margin - 80, timeHeight - 40, grid, foreground); }
        top += section.height;
        ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(margin, top - 12); ctx.lineTo(width - margin, top - 12); ctx.stroke();
      }
    } finally { cursorTime = previousCursor; }
    return canvas.toDataURL('image/png');
  }
  function wrapText(ctx, text, width) {
    const lines = []; let line = '';
    for (const character of String(text)) {
      if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line); return lines;
  }
  function drawTime(ctx, chart, x, y, width, height, grid, text, relative = false) {
    return native.time(ctx, chart, x, y, width, height, grid, text, relative, cursorTime);
  }
  function drawFft(ctx, chart, x, y, width, height, grid, text) {
    return native.fft(ctx, chart, x, y, width, height, grid, text);
  }
  function newestTime(ids) { return native.newest(ids); }
  function element(tag, className) { const node=document.createElement(tag); if(className) node.className=className; return node; }
  function button(label, action, className='') { const node=element('button',className); node.textContent=label; node.addEventListener('click',action); return node; }
  vscode.postMessage({ type: 'ready' });
})();
