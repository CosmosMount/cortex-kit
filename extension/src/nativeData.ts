import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { Readable, Writable } from 'node:stream';

export interface NativeChart { id: string; mode: 'time' | 'fft' | 'both'; variableIds: string[]; }
export interface NativeConfig {
  revision: number; historySeconds: number; charts: NativeChart[];
  catalog: Array<{ id: string; name: string; expression: string }>; rawIds: string[];
}
export interface NativeRecordSpec { path: string; ids: string[]; names: string[]; rate: number; }
export interface NativeRecordStatus {
  recording: boolean; closing: boolean; rows: number; actualHz: number;
  elapsedSeconds: number; dropped: number; overflowFrames: number; connectionBreaks?: number; path: string; error?: string | null;
}
export interface NativeLatest {
  generation: number; revision: number; sessionId?: string | null; programGeneration?: number | null; connected: boolean; error?: string | null;
  values: Array<{ id: string; value: number | null; timestampNsExact: string; streamEpoch?: number; actualSamplesPerSecond: number; receivedAgeMs: number }>;
  receivedFrames: number; displayDroppedFrames: number;
}
export interface NativeFrame {
  generation: number; configRevision: number; revision: number; sessionId?: string | null; programGeneration?: number | null;
  charts: Array<{ id: string; start: number; end: number; columns: number; series: unknown[] }>;
  resolutionClamped: boolean; historyEvictions: number; rejectedTimestamps: number;
  displayDroppedFrames: number; errors: string[];
}
export interface NativePreview { curves: Array<{ name: string; points: Array<[number, number | null]> }>; live: boolean; status: NativeRecordStatus; }
type JsonObject = Record<string, unknown>;

/** Incremental bounded framing. No repeated concat of a growing partial frame. */
export class NativeFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  constructor(private readonly maxBytes: number) {}
  get hasPartialFrame(): boolean { return this.headerBytes !== 0 || this.payload !== undefined; }
  push(chunk: Buffer, accept: (message: JsonObject) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count); this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) continue;
        const length = this.header.readUInt32LE();
        if (length < 1 || length > this.maxBytes) throw new Error('Native RPC frame exceeds limit');
        this.payload = Buffer.allocUnsafe(length); this.payloadBytes = 0; this.headerBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count); this.payloadBytes += count; offset += count;
      if (this.payloadBytes === this.payload.length) {
        const payload = this.payload; this.payload = undefined; this.payloadBytes = 0;
        const message: unknown = JSON.parse(payload.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Native RPC message must be an object');
        accept(message as JsonObject);
      }
    }
  }
}
export function encodeNativeFrame(message: unknown, maximum = 512 * 1024): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length < 1 || payload.length > maximum) throw new Error('Native RPC request exceeds limit');
  const frame = Buffer.allocUnsafe(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); return frame;
}

/** Control and display use DIFFERENT instances/streams. Display gets one credit. */
export class NativeRpc {
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly decoder: NativeFrameDecoder;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;
  private readonly onError: (error: Error) => void;
  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly maxInFlight: number, maxReplyBytes: number,
    private readonly event: (message: JsonObject) => void = () => {}, private readonly fault: (error: Error) => void = () => {}) {
    this.decoder = new NativeFrameDecoder(maxReplyBytes);
    this.onData = chunk => { try { this.decoder.push(chunk, message => this.receive(message)); } catch (error) { this.fail(error); } };
    this.onEnd = () => this.fail(new Error(this.decoder.hasPartialFrame ? 'Truncated native RPC frame' : 'Native RPC stream ended'));
    this.onError = error => this.fail(error);
    input.on('data', this.onData); input.on('end', this.onEnd); input.on('error', this.onError);
    if ((output as unknown) !== input) output.on('error', this.onError);
  }
  get busy(): boolean { return this.pending.size >= this.maxInFlight; }
  get pendingCount(): number { return this.pending.size; }
  sendHandshake(message: unknown): void {
    if (this.disposed) throw new Error('Native channel is closed');
    this.output.write(encodeNativeFrame(message));
  }
  request<T>(method: string, args: unknown = {}, timeoutMs = 10000): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Native channel is closed'));
    if (this.busy) return Promise.reject(new Error('Native channel has no free request credit'));
    const id = this.nextId++;
    let bytes: Buffer;
    try { bytes = encodeNativeFrame({ id, method, args }); } catch (error) { return Promise.reject(error); }
    if (this.output.writableLength + bytes.length > 1024 * 1024) return Promise.reject(new Error('Native control write backlog exceeded'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Native ${method} request timed out`)), timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.output.write(bytes, error => { if (error) this.fail(error); });
    });
  }
  private receive(message: JsonObject): void {
    if (this.disposed) return;
    if (message.id === undefined) { this.event(message); return; }
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid native reply id');
    const waiting = this.pending.get(message.id as number);
    if (!waiting) return; // Late replies never grant credit for another request.
    this.pending.delete(message.id as number); clearTimeout(waiting.timer);
    if (message.ok === true) waiting.resolve(message.result);
    else waiting.reject(new Error(typeof message.error === 'string' ? message.error : 'Native request failed'));
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.dispose(failure); this.fault(failure);
  }
  dispose(reason = new Error('Native channel disposed')): void {
    if (this.disposed) return; this.disposed = true;
    this.input.off('data', this.onData); this.input.off('end', this.onEnd);
    // Retain benign error listeners until the underlying process/socket closes,
    // so a late pipe error can never become an unhandled EventEmitter error.
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
  }
}

export class NativeDataClient {
  private closing?: Promise<void>;
  private stopped = false;
  private display?: NativeRpc;
  private displaySocket?: net.Socket;
  private displayConnecting?: Promise<NativeRpc>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams,
    private readonly control: NativeRpc, private readonly plotPort: number,
    private readonly token: string, private readonly exited: Promise<void>,
    private readonly onDisplayError: (error: Error) => void,
    private readonly onError: (error: Error) => void) {}
  static async launch(executable: string, options: {
    args?: string[]; onError?: (error: Error) => void; onDisplayError?: (error: Error) => void; readyTimeoutMs?: number;
  } = {}): Promise<NativeDataClient> {
    const token = randomBytes(32).toString('hex');
    const child = spawn(executable, options.args ?? ['--native-data'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CORTEX_KIT_DATA_TOKEN: token },
    });
    let client: NativeDataClient | undefined, stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    let readyResolve!: (message: JsonObject) => void, readyReject!: (error: Error) => void;
    const ready = new Promise<JsonObject>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const fault = (error: Error) => {
      readyReject(error);
      if (client && !client.stopped) { options.onError?.(error); void client.close(); }
    };
    const control = new NativeRpc(child.stdout, child.stdin, 16, 1024 * 1024, message => {
      if (message.event === 'ready') readyResolve(message);
    }, fault);
    child.once('error', fault);
    child.once('exit', (code, signal) => fault(new Error(`Native data process exited (${code ?? signal ?? 'unknown'}). ${stderr}`)));
    const timer = setTimeout(() => readyReject(new Error('Native data startup handshake timed out; rebuild the Rust backend before enabling this setting')), options.readyTimeoutMs ?? 8000);
    try {
      const hello = await ready;
      const capabilities = hello.capabilities;
      if (hello.protocolVersion !== 1 || !Number.isInteger(hello.plotPort) || Number(hello.plotPort) < 1 || Number(hello.plotPort) > 65535
        || !Array.isArray(capabilities) || !['latest', 'render', 'nativeCsv'].every(capability => capabilities.includes(capability))) {
        throw new Error('Unsupported native data backend capabilities');
      }
      // Numeric/control/recording do not depend on the optional display socket.
      client = new NativeDataClient(child, control, Number(hello.plotPort), token, exited,
        options.onDisplayError ?? (() => {}), options.onError ?? (() => {}));
      return client;
    } catch (error) { control.dispose(); child.stdin.end(); child.kill(); throw error; }
    finally { clearTimeout(timer); }
  }
  private ensureDisplay(): Promise<NativeRpc> {
    if (this.stopped) return Promise.reject(new Error('Native process is closed'));
    if (this.display) return Promise.resolve(this.display);
    if (this.displayConnecting) return this.displayConnecting;
    const socket = net.createConnection({ host: '127.0.0.1', port: this.plotPort }); socket.setNoDelay(true);
    this.displaySocket = socket;
    const connecting = new Promise<NativeRpc>((resolve, reject) => {
      let complete = false, failedOnce = false;
      const timer = setTimeout(() => failed(new Error('Native display handshake timed out')), 5000);
      const failed = (error: Error) => {
        if (failedOnce) return; failedOnce = true;
        clearTimeout(timer); rpc.dispose(error); socket.destroy();
        if (this.display === rpc) this.display = undefined;
        if (this.displaySocket === socket) this.displaySocket = undefined;
        // Display loss must NEVER close the numeric channel or stop recording.
        if (!this.stopped) this.onDisplayError(error);
        if (!complete) { complete = true; reject(error); }
      };
      const rpc = new NativeRpc(socket, socket, 1, 4 * 1024 * 1024, message => {
        if (message.ok !== true || message.protocolVersion !== 1) { failed(new Error('Native display authentication failed')); return; }
        clearTimeout(timer); if (this.stopped) { failed(new Error('Native client closed during handshake')); return; }
        complete = true; this.display = rpc; resolve(rpc);
      }, failed);
      socket.once('connect', () => { try { rpc.sendHandshake({ token: this.token }); } catch (error) { failed(error as Error); } });
      socket.once('close', () => failed(new Error('Native display socket closed')));
    });
    this.displayConnecting = connecting;
    void connecting.then(() => { if (this.displayConnecting === connecting) this.displayConnecting = undefined; },
      () => { if (this.displayConnecting === connecting) this.displayConnecting = undefined; });
    return connecting;
  }
  connect(info: { port: number; token: string; protocolVersion: number; generation: number }): Promise<unknown> { return this.control.request('connect', info); }
  disconnect(generation: number): Promise<unknown> { return this.control.request('disconnect', { generation }); }
  configure(config: NativeConfig): Promise<{ revision: number }> { return this.control.request('configure', config); }
  clear(): Promise<unknown> { return this.control.request('clear'); }
  latest(ids: string[], after: number): Promise<NativeLatest> { return this.control.request('latest', { ids, after }); }
  async render(generation: number, configRevision: number, charts: Array<{ id: string; columns: number }>): Promise<NativeFrame> {
    const display = await this.ensureDisplay();
    return display.request('render', { generation, configRevision, charts });
  }
  startRecording(spec: NativeRecordSpec): Promise<{ started: boolean }> { return this.control.request('recordStart', spec, 15000); }
  stopRecording(): Promise<NativeRecordStatus> { return this.control.request('recordStop', {}, 15000); }
  recordingStatus(): Promise<NativeRecordStatus> { return this.control.request('recordStatus'); }
  async preview(): Promise<NativePreview | undefined> {
    const display = await this.ensureDisplay();
    if (display.busy) return undefined;
    return display.request('recordPreview');
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.stopped = true;
    this.closing = (async () => {
      this.display?.dispose(); this.displaySocket?.destroy();
      try { await this.control.request('shutdown', {}, 1000); } catch { /* EOF also requests native finalization. */ }
      this.child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 12000); })]);
      if (timer) clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.onError(new Error('Native shutdown timed out; process terminated, CSV finalization is not confirmed'));
        this.child.kill();
      }
      this.control.dispose();
    })(); return this.closing;
  }
}
