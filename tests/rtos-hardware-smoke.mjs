// Read-only ThreadX/FreeRTOS inspection against the currently running firmware.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { DapClient } from './dap-client.mjs';
const require = createRequire(import.meta.url);
const { RtosInspector, OccupancySamples } = require('../extension/out/rtosModel.js');
const [programBinary, chip, output, selectionFile] = process.argv.slice(2);
if (!programBinary || !chip || !output) { throw new Error('Usage: node tests/rtos-hardware-smoke.mjs <elf> <chip> <output.json> [selection.json]'); }
const child = spawn(process.env.CORTEX_KIT_BACKEND ?? 'target/release/cortex-kit-dap.exe', [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
let stderr = ''; child.stderr.on('data', b => stderr += b.toString());
const dap = new DapClient(child);
let connected = false;
try {
  await dap.request('initialize', { adapterID: 'cortex-kit' });
  await dap.request('attach', { chip, programBinary, stopOnEntry: false, plotOnly: true, probe: {selector:'auto',protocol:'swd',speedKHz:10000,connectUnderReset:false},flashing:{enabled:false},acquisition:{requestedSamplesPerSecond:5000} }, 60000);
  connected = true;
  const { variables } = await dap.request('cortexKit/getCatalog');
  const { layouts } = await dap.request('cortexKit/getRtosLayouts');
  const inspector = new RtosInspector(variables,layouts,async(address,count) => {
    const response = await dap.request('readMemory',{memoryReference:`0x${address.toString(16)}`,count});
    const bytes=Buffer.from(response.data,'base64'); assert.equal(bytes.length,count);return bytes;
  });
  await dap.request('configurationDone');
  const selection = selectionFile ? JSON.parse(readFileSync(selectionFile,'utf8').replace(/^\uFEFF/,'')) : {ids:[]};
  await dap.request('cortexKit/setSubscriptions',{...selection, requestedSamplesPerSecond:5000});
  await delay(3000);
  const baseline = await dap.request('cortexKit/getState');
  const snapshots=[]; const samples = new OccupancySamples(); const errors=[]; const started=Date.now(); let last=0;
  while(Date.now()-started<10000) {
    samples.add(Date.now(),await inspector.current());
    if(Date.now()-last>=1000) { try { snapshots.push(await inspector.snapshot()); } catch(e) {errors.push(e.message);} last=Date.now(); }
    await delay(100*(0.8+Math.random()*0.4));
  }
  const state=await dap.request('cortexKit/getState'); const distribution=samples.distribution(Date.now());
  const report={rtos:inspector.rtos,layouts:layouts.map(t=>({name:t.name,fields:t.children.length})),baseline,state,errors,snapshots,observations:distribution.count,shares:Object.fromEntries(distribution.shares)};
  writeFileSync(output,JSON.stringify(report,null,2));
  assert.ok(snapshots.length>=5,`not enough readable snapshots: ${errors.join('; ')}`);
  assert.ok(snapshots[0].threads.length>0);
  assert.ok(['running','sleeping'].includes(state.targetState));
  console.log(JSON.stringify({rtos:inspector.rtos,threads:snapshots.at(-1).threads,observations:distribution.count,shares:report.shares,baselineSps:baseline.actualSamplesPerSecond,withThreadsSps:state.actualSamplesPerSecond,errors},null,2));
} finally {
  try { if(connected) { await dap.request('disconnect',{terminateDebuggee:false},10000); } } finally {child.kill();}
  if(stderr) console.error(stderr.slice(-3000));
}
