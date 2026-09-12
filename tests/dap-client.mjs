const describeError = error => error instanceof Error ? error.message : String(error);
export class DapClient {
  constructor(childProcess) {
    this.child = childProcess;
    this.sequence = 1;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.input = Buffer.alloc(0);
    this.closedError = undefined;

    childProcess.stdout.on('data', chunk => this.accept(chunk));
    childProcess.stdout.on('error', error => this.close(new Error(`DAP stdout failed: ${describeError(error)}`)));
    childProcess.stdout.on('end', () => this.close(new Error('DAP stdout ended')));
    // A failed request can close the adapter while a write is still buffered. Keeping
    // this listener installed prevents the resulting EPIPE/ECONNRESET from escaping.
    childProcess.stdin.on('error', error => this.close(new Error(`DAP stdin failed: ${describeError(error)}`)));
    childProcess.on('error', error => this.close(new Error(`DAP process failed: ${describeError(error)}`)));
    childProcess.on('exit', (code, signal) => {
      this.close(new Error(`DAP exited (${signal ? `signal ${signal}` : `code ${code}`})`));
    });
  }

  request(command, args = {}, timeoutMs = 30_000) {
    if (this.closedError) return Promise.reject(this.closedError);
    const seq = this.sequence++;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    const frame = Buffer.concat([header, body]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(seq)) return;
        reject(new Error(`${command}: DAP response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try {
        this.child.stdin.write(frame, error => {
          if (error) this.rejectPending(seq, new Error(`${command}: DAP write failed: ${describeError(error)}`));
        });
      } catch (error) {
        this.rejectPending(seq, new Error(`${command}: DAP write failed: ${describeError(error)}`));
      }
    });
  }

  waitForEvent(predicate, timeoutMs = 10_000, description = 'DAP event') {
    const queuedIndex = this.events.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.events.splice(queuedIndex, 1)[0]);
    if (this.closedError) return Promise.reject(this.closedError);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`${description} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  accept(chunk) {
    if (this.closedError) return;
    this.input = Buffer.concat([this.input, chunk]);
    try {
      while (true) {
        const headerEnd = this.input.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.input.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error(`DAP frame has no Content-Length header: ${header}`);
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (this.input.length < start + length) return;
        const message = JSON.parse(this.input.subarray(start, start + length).toString('utf8'));
        this.input = this.input.subarray(start + length);
        this.dispatch(message);
      }
    } catch (error) {
      this.close(new Error(`invalid DAP stream: ${describeError(error)}`));
    }
  }

  dispatch(message) {
    if (message?.type === 'response') {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body ?? {});
      else pending.reject(new Error(`${pending.command}: ${message.message ?? 'request failed'}`));
      return;
    }
    if (message?.type !== 'event') return;
    const waiterIndex = this.eventWaiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.eventWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.events.push(message);
      if (this.events.length > 100) this.events.shift();
    }
  }

  rejectPending(seq, error) {
    const pending = this.pending.get(seq);
    if (!pending) return;
    this.pending.delete(seq);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const [seq] of this.pending) this.rejectPending(seq, error);
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
