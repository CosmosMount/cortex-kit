import * as vscode from 'vscode';

/** Observe actual DAP requests/responses, including flashing initiated by F5. */
export function registerFlashOutput(output: vscode.OutputChannel): vscode.Disposable {
  return vscode.debug.registerDebugAdapterTrackerFactory('cortex-kit', {
    createDebugAdapterTracker(session) {
      const pending = new Map<number, number>();
      const log = (message: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
      return {
        onWillReceiveMessage(message) {
          if (message.type !== 'request') { return; }
          const args = message.arguments ?? {};
          if (message.command !== 'cortexKit/flash' && !(message.command === 'launch' && args.flashing?.enabled)) { return; }
          pending.set(message.seq, Date.now());
          output.show(true);
          log(`Starting flash: ${session.name}`);
          log(`Image: ${args.path ?? args.programBinary ?? '(not configured)'}`);
          log(`Target: ${args.chip ?? session.configuration.chip}; verify: ${args.verify ?? args.flashing?.verify ?? true}; reset after: ${args.resetAfter ?? args.flashing?.resetAfter ?? true}`);
          log('Backend is programming firmware (erase/write and verification when enabled)…');
        },
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'output' && pending.size) {
            output.append(message.body?.output ?? '');
          }
          if (message.type !== 'response') { return; }
          const started = pending.get(message.request_seq);
          if (started === undefined) { return; }
          pending.delete(message.request_seq);
          const elapsed = ((Date.now() - started) / 1000).toFixed(1);
          log(message.success
            ? `Flash completed successfully (${elapsed}s). Backend confirmed completion.`
            : `Flash FAILED (${elapsed}s): ${message.message ?? 'Unknown backend error'}`);
        },
        onError(error) { if (pending.size) { log(`Flash adapter error: ${error.message}`); } },
        onExit() {
          if (pending.size) { log('Flash interrupted: adapter exited before confirming completion.'); pending.clear(); }
        },
      };
    },
  });
}
