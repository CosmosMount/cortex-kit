(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  byId('refresh').onclick = () => vscode.postMessage({command: 'refresh'});
  byId('reset').onclick = () => vscode.postMessage({command: 'reset'});
  byId('auto').onchange = e => vscode.postMessage({command: 'auto', value: e.target.checked});
  byId('rate').onchange = e => vscode.postMessage({command: 'rate', value: Number(e.target.value)});
  const percent = value => value === undefined ? '—' : value.toFixed(1) + '%';
  window.addEventListener('message', ({data}) => {
    byId('status').textContent = data.status;
    byId('status').className = data.error ? 'error' : '';
    if (data.note) { byId('note').textContent = data.note; }
    byId('rows').replaceChildren(...(data.rows || []).map(t => {
      const row = document.createElement('tr'); if (t.state === 'Running') { row.className = 'running'; }
      for (const text of [t.name, t.state, t.priority, percent(t.sampled), percent(t.runtime), `${t.stackUsed ?? '—'} / ${t.stackBytes ?? '—'}`, t.runs ?? '—', '0x' + t.address.toString(16).padStart(8, '0')]) {
        const cell = document.createElement('td'); cell.textContent = String(text); row.appendChild(cell);
      }
      return row;
    }));
  });
  vscode.postMessage({command: 'ready'});
})();
