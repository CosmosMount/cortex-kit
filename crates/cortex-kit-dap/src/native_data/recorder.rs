//! An independent raw-data sink. A slow disk never blocks the TCP reader.
use super::{DataSender, Ingress, ReplySender, Shared, data_queue, reply};
use cortex_kit_core::SampleBatch;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::VecDeque, fs::File, io::{BufWriter, Write}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, thread::JoinHandle};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec { pub path: String, pub ids: Vec<String>, pub names: Vec<String>, pub rate: u32 }
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub recording: bool, pub closing: bool, pub rows: u64, pub actual_hz: f64,
    pub elapsed_seconds: f64, pub dropped: u64, pub overflow_frames: u64, pub connection_breaks: u64,
    pub path: String, pub error: Option<String>,
}
#[derive(Clone)] struct Row { elapsed: f64, epoch: u64, values: Vec<f64> }
#[derive(Default)] pub struct RecordState { pub status: Status, names: Vec<String>, preview: VecDeque<Row> }
#[derive(Default)] struct Completion { request: Option<(Option<u64>, Option<String>)>, done: bool }
pub struct Handle {
    sender: DataSender, overflow: Arc<AtomicU64>, finish: Arc<Mutex<Completion>>,
    shared: Arc<Shared>, output: ReplySender,
    pub thread: JoinHandle<()>,
}
impl Handle {
    pub fn offer(&self, data: Ingress) -> bool {
        let count = u64::from(data.batch.sample_count);
        if self.sender.offer(data) { true } else { self.overflow.fetch_add(count, Ordering::Relaxed); false }
    }
    pub fn finish(self, id: Option<u64>, reason: Option<String>) -> JoinHandle<()> {
        let done = {
            let mut completion = self.finish.lock().unwrap();
            if completion.done { true } else {
                self.shared.record.lock().unwrap().status.closing = true;
                completion.request = Some((id, reason)); false
            }
        };
        // A disk error can finish the writer before the stop command arrives.
        // Completion and the final status are published under the same lock.
        if done { if let Some(id) = id { reply(&self.output, id, Ok(json!(self.shared.record.lock().unwrap().status))); } }
        drop(self.sender); self.thread
    }
}
fn cell(s: &str) -> String { if s.contains([',','"','\r','\n']) { format!("\"{}\"", s.replace('"',"\"\"")) } else { s.to_owned() } }
fn header(names: &[String]) -> String {
    let mut fields = vec!["elapsed_s".to_owned(), "timestamp_ns".to_owned(), "stream_epoch".to_owned()];
    for name in names { let mut unique = name.clone(); let mut n = 2;
        while fields.contains(&unique) { unique = format!("{name} ({n})"); n += 1; } fields.push(unique); }
    format!("\u{feff}{}\r\n", fields.iter().map(|s| cell(s)).collect::<Vec<_>>().join(","))
}
pub fn start(spec: Spec, id: u64, shared: Arc<Shared>, output: ReplySender) -> Result<Handle, String> {
    if spec.ids.is_empty() || spec.ids.len() > 64 || spec.ids.len() != spec.names.len()
        || spec.ids.iter().collect::<std::collections::HashSet<_>>().len() != spec.ids.len()
        || !(1..=100000).contains(&spec.rate) || spec.path.is_empty() || spec.path.len() > 32768 {
        return Err("invalid native recording selection/path/rate".into());
    }
    {
        let mut state = shared.record.lock().unwrap();
        if state.status.recording || state.status.closing { return Err("a recording is already active or closing".into()); }
        *state = RecordState { status: Status { recording: true, path: spec.path.clone(), ..Status::default() }, names: spec.names.clone(), preview: VecDeque::new() };
    }
    let (sender, receiver) = data_queue(16 * 1024 * 1024);
    let overflow = Arc::new(AtomicU64::new(0)); let thread_overflow = overflow.clone();
    let finish = Arc::new(Mutex::new(Completion::default())); let finish_thread = finish.clone();
    let handle_shared = shared.clone(); let handle_output = output.clone();
    let initial_breaks = shared.connection_breaks.load(Ordering::Relaxed);
    let thread = std::thread::spawn(move || {
        let mut acknowledged = false;
        let result = (|| -> Result<(), String> {
            // Only extension-authorized paths arrive here; the display socket
            // has no record/start/write capability.
            let file = File::create(&spec.path).map_err(|e| e.to_string())?;
            let mut writer = BufWriter::with_capacity(256 * 1024, file);
            writer.write_all(header(&spec.names).as_bytes()).map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
            reply(&output, id, Ok(json!({"started":true}))); acknowledged = true;
            let mut sampler = Sampler::new(spec.ids.clone(), spec.rate);
            let mut baseline = None; let mut last_publish = std::time::Instant::now();
            loop {
                let queued = match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                    Ok(packet) => packet,
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        writer.flush().map_err(|e|e.to_string())?;
                        last_publish = std::time::Instant::now();
                        continue;
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                };
                let batch = &queued.data.batch;
                let rows = sampler.accept(batch)?;
                baseline.get_or_insert(batch.dropped_frames);
                for (timestamp, row) in &rows {
                    write!(writer,"{:.9},{},{}",row.elapsed,timestamp,row.epoch).map_err(|e|e.to_string())?;
                    for value in &row.values {
                        writer.write_all(b",").map_err(|e|e.to_string())?;
                        if value.is_nan() { writer.write_all(b"NaN").map_err(|e|e.to_string())?; }
                        else if *value == f64::INFINITY { writer.write_all(b"Infinity").map_err(|e|e.to_string())?; }
                        else if *value == f64::NEG_INFINITY { writer.write_all(b"-Infinity").map_err(|e|e.to_string())?; }
                        else { write!(writer,"{value}").map_err(|e|e.to_string())?; }
                    }
                    writer.write_all(b"\r\n").map_err(|e|e.to_string())?;
                }
                {
                    let mut state = shared.record.lock().unwrap();
                    for (_, row) in rows { if state.preview.len() == 4000 { state.preview.pop_front(); } state.preview.push_back(row); }
                    state.status.rows = sampler.count; state.status.elapsed_seconds = sampler.elapsed;
                    state.status.actual_hz = if sampler.elapsed > 0.0 { sampler.count.saturating_sub(1) as f64 / sampler.elapsed } else { 0.0 };
                    state.status.dropped = batch.dropped_frames.saturating_sub(baseline.unwrap_or(0));
                    state.status.connection_breaks = shared.connection_breaks.load(Ordering::Relaxed).saturating_sub(initial_breaks);
                }
                if last_publish.elapsed().as_millis() >= 250 { writer.flush().map_err(|e|e.to_string())?; last_publish = std::time::Instant::now(); }
            }
            writer.flush().map_err(|e|e.to_string())?;
            // stop success means accepted rows were flushed, not fsync/power-loss durability.
            Ok(())
        })();
        let mut completion = finish_thread.lock().unwrap();
        let (finish_id, finish_reason) = completion.request.take().unwrap_or((None,None));
        let overflow = thread_overflow.load(Ordering::Relaxed);
        let status = {
            let mut state = shared.record.lock().unwrap(); state.status.recording = false; state.status.closing = false;
            state.status.overflow_frames = overflow;
            state.status.connection_breaks = shared.connection_breaks.load(Ordering::Relaxed).saturating_sub(initial_breaks);
            state.status.error = result.as_ref().err().cloned().or_else(|| if overflow > 0 {
                Some(format!("raw recording queue overflow: {overflow} frames were not recorded; accepted prefix was flushed"))
            } else { finish_reason }); state.status.clone()
        };
        completion.done = true; drop(completion);
        if !acknowledged { reply(&output,id,Err(status.error.clone().unwrap_or_else(||"recording failed to start".into()))); }
        if let Some(id) = finish_id { reply(&output,id,Ok(json!(status))); }
    });
    Ok(Handle { sender, overflow, finish, shared: handle_shared, output: handle_output, thread })
}
struct Sampler { ids: Vec<String>, rate: u32, first: Option<u64>, last: Option<u64>, next_elapsed: f64, source: Option<(String,u64)>, count: u64, elapsed: f64 }
impl Sampler {
    fn new(ids: Vec<String>, rate: u32) -> Self { Self { ids,rate,first:None,last:None,next_elapsed:f64::NEG_INFINITY,source:None,count:0,elapsed:0.0 } }
    fn accept(&mut self, batch: &SampleBatch) -> Result<Vec<(u64,Row)>, String> {
        let indexes: Option<Vec<_>> = self.ids.iter().map(|id|batch.channel_ids.iter().position(|i|i==id)).collect();
        let Some(indexes) = indexes else { return Ok(Vec::new()); };
        if self.source.as_ref().is_some_and(|(s,g)|s!=&batch.session_id || *g!=batch.program_generation) { return Err("target session/firmware changed during recording".into()); }
        self.source.get_or_insert_with(||(batch.session_id.clone(),batch.program_generation));
        let interval = 1e9 / self.rate as f64; let mut rows = Vec::new();
        for sample in 0..batch.sample_count as usize {
            let t = batch.start_timestamp_ns + sample as u64 * batch.sample_period_ns;
            let relative = t.saturating_sub(self.first.unwrap_or(t)) as f64;
            if self.last.is_some_and(|last|t<=last) || relative + 0.5 < self.next_elapsed { continue; }
            self.first.get_or_insert(t); self.last = Some(t); self.next_elapsed = ((relative/interval).floor()+1.0)*interval;
            self.count+=1; self.elapsed=relative/1e9;
            rows.push((t,Row { elapsed:self.elapsed,epoch:batch.stream_epoch, values:indexes.iter().map(|i|batch.values[sample*batch.channel_ids.len()+i]).collect() }));
        } Ok(rows)
    }
}
pub fn preview(shared: &Shared) -> Value {
    // Only copy the bounded preview while locked; plot reduction never owns the
    // writer's status lock. No raw recording bytes pass through the Webview.
    let (names, rows, status) = {
        let state = shared.record.lock().unwrap();
        (state.names.clone(), state.preview.iter().cloned().collect::<Vec<_>>(), state.status.clone())
    };
    let width = (2000 / names.len().max(1)).clamp(4,256);
    let curves: Vec<_> = names.iter().enumerate().map(|(channel,name)| {
        let mut points = Vec::<Value>::new();
        let block = rows.len().div_ceil(width);
        let mut previous_epoch = None;
        if block > 0 { for chunk in rows.chunks(block) {
            let mut indexes = vec![0,chunk.len()-1];
            let (mut low,mut high,mut gap) = (None::<usize>,None::<usize>,None::<usize>);
            let mixed = chunk.iter().any(|row|row.epoch!=chunk[0].epoch);
            for (i,row) in chunk.iter().enumerate() {
                let value = row.values[channel];
                if !value.is_finite() { gap.get_or_insert(i); continue; }
                if low.is_none_or(|j|value<chunk[j].values[channel]) { low=Some(i); }
                if high.is_none_or(|j|value>chunk[j].values[channel]) { high=Some(i); }
            }
            indexes.extend(low); indexes.extend(high); indexes.extend(gap);
            indexes.sort_unstable(); indexes.dedup();
            for i in indexes { let row=&chunk[i];
                // In an undersampled mixed-epoch pixel do not invent continuity.
                if mixed || previous_epoch.is_some_and(|e|e!=row.epoch) { points.push(json!([row.elapsed,null])); }
                points.push(json!([row.elapsed,if row.values[channel].is_finite(){Some(row.values[channel])}else{None}]));
                previous_epoch=Some(row.epoch);
            }
            if mixed { points.push(json!([chunk.last().unwrap().elapsed,null])); previous_epoch=None; }
        }}
        json!({"name":name,"points":points})
    }).collect();
    json!({"curves":curves,"live":true,"status":status})
}
#[cfg(test)] mod tests {
    use super::*;
    fn batch(epoch:u64,start:u64)->SampleBatch { SampleBatch { protocol_version:1,session_id:"s".into(),program_generation:1,stream_epoch:epoch,batch_sequence:1,channel_ids:vec!["a".into()],sample_count:5,start_timestamp_ns:start,sample_period_ns:1000000,dropped_frames:0,values:vec![1.0,2.0,3.0,4.0,5.0] } }
    #[test] fn selects_real_frames_and_keeps_pause_interval() {
        let mut sampler=Sampler::new(vec!["a".into()],500);
        let rows=sampler.accept(&batch(1,0)).unwrap();assert_eq!(rows.iter().map(|r|r.0).collect::<Vec<_>>(),[0,2000000,4000000]);
        let rows=sampler.accept(&batch(2,1000000000)).unwrap();assert_eq!(rows[0].1.elapsed,1.0);assert_eq!(rows[0].1.epoch,2);
    }
    #[test] fn unrelated_groups_never_fabricate_values() {
        let mut sampler=Sampler::new(vec!["missing".into()],1000);assert!(sampler.accept(&batch(1,0)).unwrap().is_empty());
    }
    #[test] fn csv_header_quotes_and_uniquifies() {
        assert_eq!(header(&["a,b".into(),"a,b".into(),"timestamp_ns".into()]),"\u{feff}elapsed_s,timestamp_ns,stream_epoch,\"a,b\",\"a,b (2)\",timestamp_ns (2)\r\n");
    }
    #[test] fn stop_acknowledges_only_after_accepted_rows_are_flushed() {
        let shared=Arc::new(Shared::default()); let (tx,rx)=crossbeam_channel::bounded(16);
        let output=ReplySender{sender:tx,shared:shared.clone()};
        let name=format!("cortex-kit-native-{}-{}.csv",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let path=std::env::temp_dir().join(name);
        let h=start(Spec{path:path.to_string_lossy().into_owned(),ids:vec!["a".into()],names:vec!["a".into()],rate:1000},1,shared.clone(),output).unwrap();
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap()["id"],1);
        assert!(h.offer(Ingress{generation:1,loss:0,batch:Arc::new(batch(1,0))}));
        h.finish(Some(2),None).join().unwrap();
        let stopped=rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(stopped["id"],2);assert_eq!(stopped["result"]["rows"],5);assert_eq!(stopped["result"]["closing"],false);
        let text=std::fs::read_to_string(&path).unwrap();assert_eq!(text.lines().count(),6);assert!(text.contains("0.004000000,4000000,1,5"));
        std::fs::remove_file(path).unwrap();
    }
    #[test] fn preview_is_bounded_even_when_every_sample_changes_epoch() {
        let shared=Shared::default();
        {let mut state=shared.record.lock().unwrap();state.names=vec!["x".into();64];
            for i in 0..4000 {state.preview.push_back(Row{elapsed:i as f64,epoch:i,values:vec![i as f64;64]});}}
        let message=preview(&shared);let total:usize=message["curves"].as_array().unwrap().iter().map(|curve|curve["points"].as_array().unwrap().len()).sum();
        assert!(total<=22000);assert!(serde_json::to_vec(&message).unwrap().len()<super::super::wire::MAX_REPLY_BYTES);
    }

}
