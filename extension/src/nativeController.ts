import { NativeConfig, NativeDataClient, NativeLatest, NativeFrame, NativeRecordSpec, NativeRecordStatus, NativePreview } from './nativeData';

type Connection = { port: number; token: string; protocolVersion: number };
/** Lifecycle and configuration only. This module never receives raw samples. */
export class NativeController {
  private client?: NativeDataClient;
  private launching?: Promise<NativeDataClient>;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private generation = 0;
  private connected = false;
  private historyValid = false;
  private connectionKey?: string;
  private config?: NativeConfig;
  private configKey = '';
  private sentRevision = -1;
  private ids: string[] = [];
  private latestRevision = 0;
  private polling = false;
  private pollInterval = 100;
  private lastPoll = -Infinity;
  private lastError = '';
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly executable: string,
    private readonly values: (latest: NativeLatest) => void,
    private readonly error: (error: Error) => void,
    private readonly launch: typeof NativeDataClient.launch = NativeDataClient.launch) {
    this.timer = setInterval(() => { void this.poll(); }, 16);
  }
  private report(error: unknown): void {
    const e = error instanceof Error ? error : new Error(String(error));
    if (e.message !== this.lastError) { this.lastError = e.message; this.error(e); }
  }
  private ensure(): Promise<NativeDataClient> {
    if (this.disposed) return Promise.reject(new Error('Native controller disposed'));
    if (this.client) return Promise.resolve(this.client);
    if (!this.launching) {
      this.launching = this.launch(this.executable, { onError: error => {
        this.connected = false; this.historyValid = false; this.report(error);
      }, onDisplayError: error => this.report(error) }).then(client => {
        if (this.disposed) { void client.close(); throw new Error('Native controller disposed while starting'); }
        this.client = client; return client;
      });
      // Fail closed: never automatically fall back to a second raw TCP reader.
      void this.launching.catch(error => this.report(error));
    }
    return this.launching;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.serial.then(operation);
    this.serial = current.catch(error => { this.report(error); });
    return current;
  }
  update(config: Omit<NativeConfig, 'revision'>, ids: string[], refreshHz: number): void {
    const key = JSON.stringify(config);
    if (key !== this.configKey) {
      this.configKey = key; this.config = { ...config, revision: (this.config?.revision ?? 0) + 1 };
    }
    const selected = [...new Set(ids)];
    if (JSON.stringify(selected) !== JSON.stringify(this.ids)) { this.ids = selected; this.latestRevision = 0; }
    this.pollInterval = 1000 / Math.max(1, Math.min(60, Number.isFinite(refreshHz) ? refreshHz : 10));
  }
  private async syncConfig(client: NativeDataClient): Promise<void> {
    for (;;) {
      const config = this.config;
      if (!config || config.revision === this.sentRevision) return;
      await client.configure(config); this.sentRevision = config.revision;
      // Coalesce rapid edits: skip every intermediate configuration not sent yet.
    }
  }
  connect(info: Connection): Promise<void> {
    const key = JSON.stringify(info);
    if (this.connectionKey === key) return this.serial.then(() => {});
    this.connectionKey = key; this.connected = false; this.historyValid = false;
    const generation = ++this.generation; this.latestRevision = 0;
    return this.enqueue(async () => {
      const client = await this.ensure();
      if (this.disposed || generation !== this.generation || this.connectionKey !== key) return;
      await this.syncConfig(client);
      await client.connect({ ...info, generation });
      if (generation === this.generation && this.connectionKey === key) { this.connected = true; this.historyValid = true; }
    });
  }
  disconnect(): void {
    const generation = this.generation;
    this.connectionKey = undefined; this.connected = false;
    if (this.client || this.launching) void this.enqueue(async () => {
      const client = await this.ensure(); await client.disconnect(generation);
    }).catch(() => {});
  }
  invalidateHistory(): void { this.historyValid = false; }
  get hasHistory(): boolean { return this.historyValid; }
  private async poll(): Promise<void> {
    if (!this.connected || !this.client || this.polling || this.disposed || performance.now() - this.lastPoll < this.pollInterval) return;
    this.lastPoll = performance.now(); this.polling = true; const generation = this.generation;
    try {
      const latest = await this.client.latest(this.ids, this.latestRevision);
      if (generation !== this.generation || latest.generation !== generation || !this.connected) return;
      this.latestRevision = latest.revision;
      if (latest.error) this.report(new Error(latest.error)); else this.lastError = '';
      this.values(latest);
    } catch (error) { this.report(error); } finally { this.polling = false; }
  }
  async render(charts: Array<{ id: string; columns: number }>): Promise<NativeFrame> {
    if (!this.historyValid) throw new Error('Native display is waiting for the current target session');
    const generation = this.generation;
    const client = await this.ensure();
    await this.enqueue(() => this.syncConfig(client));
    const revision = this.config?.revision ?? 0;
    const frame = await client.render(generation, revision, charts);
    if (!this.historyValid || generation !== this.generation || frame.generation !== generation || frame.configRevision !== this.config?.revision) {
      throw new Error('Native display response belongs to an old session/configuration');
    }
    return frame;
  }
  async startRecording(spec: NativeRecordSpec): Promise<void> {
    await this.serial;
    if (!this.connected) throw new Error('Native recording requires an active data connection');
    await (await this.ensure()).startRecording(spec);
  }
  async stopRecording(): Promise<NativeRecordStatus> {
    const client = await this.ensure();
    // Session disconnect can already have initiated asynchronous finalization.
    let status = await client.recordingStatus();
    if (status.recording && !status.closing) {
      try { status = await client.stopRecording(); if (!status.recording && !status.closing) return status; }
      catch (error) { status = await client.recordingStatus(); if (!status.closing) throw error; }
    }
    const deadline = performance.now() + 15000;
    while (status.closing || status.recording) {
      if (performance.now() >= deadline) throw new Error('CSV finalization timed out; saved data is not confirmed');
      await new Promise(resolve => setTimeout(resolve, 50)); status = await client.recordingStatus();
    }
    return status;
  }
  async recordingStatus(): Promise<NativeRecordStatus> { return (await this.ensure()).recordingStatus(); }
  async preview(): Promise<NativePreview | undefined> { return (await this.ensure()).preview(); }
  async dispose(): Promise<void> {
    this.disposed = true; this.connected = false; clearInterval(this.timer);
    if (this.client) await this.client.close();
    else if (this.launching) { try { const client = await this.launching; await client.close(); } catch { /* Startup failed. */ } }
  }
}
