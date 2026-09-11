use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use cortex_kit_core::SampleBatch;
use crossbeam_channel::{Sender, bounded};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct DapMessage {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub command: Option<String>,
    pub arguments: Option<Value>,
}

pub struct DapReader<R: Read> {
    input: BufReader<R>,
}
impl<R: Read> DapReader<R> {
    pub fn new(input: R) -> Self {
        Self {
            input: BufReader::new(input),
        }
    }
    pub fn next_message(&mut self) -> io::Result<Option<DapMessage>> {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            if self.input.read_line(&mut line)? == 0 {
                return Ok(None);
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let length = content_length
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
        let mut payload = vec![0; length];
        self.input.read_exact(&mut payload)?;
        serde_json::from_slice(&payload)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}

pub struct DapWriter<W: Write> {
    output: W,
    sequence: AtomicU64,
}
impl<W: Write> DapWriter<W> {
    pub fn new(output: W) -> Self {
        Self {
            output,
            sequence: AtomicU64::new(1),
        }
    }
    pub fn response(
        &mut self,
        request: &DapMessage,
        success: bool,
        body: Value,
        message: Option<String>,
    ) -> io::Result<()> {
        self.write(json_object(Response {
            seq: self.next(),
            kind: "response",
            request_seq: request.seq,
            success,
            command: request.command.as_deref().unwrap_or_default(),
            message,
            body,
        }))
    }
    pub fn event(&mut self, event: &str, body: Value) -> io::Result<()> {
        self.write(json_object(Event {
            seq: self.next(),
            kind: "event",
            event,
            body,
        }))
    }
    fn next(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }
    fn write(&mut self, value: Value) -> io::Result<()> {
        let bytes = serde_json::to_vec(&value)?;
        write!(self.output, "Content-Length: {}\r\n\r\n", bytes.len())?;
        self.output.write_all(&bytes)?;
        self.output.flush()
    }
}

#[derive(Serialize)]
struct Response<'a> {
    seq: u64,
    #[serde(rename = "type")]
    kind: &'static str,
    request_seq: u64,
    success: bool,
    command: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    body: Value,
}
#[derive(Serialize)]
struct Event<'a> {
    seq: u64,
    #[serde(rename = "type")]
    kind: &'static str,
    event: &'a str,
    body: Value,
}
fn json_object(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("serializable DAP message")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChannelInfo {
    pub port: u16,
    pub token: String,
    pub protocol_version: u16,
}

pub fn start_data_server() -> io::Result<(DataChannelInfo, Sender<SampleBatch>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let token = format!(
        "{:x}{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let expected = token.clone();
    let (sender, receiver) = bounded::<SampleBatch>(8);
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else { continue };
            let Ok(reader_stream) = stream.try_clone() else {
                continue;
            };
            let mut reader = BufReader::new(reader_stream);
            let mut supplied = String::new();
            if reader.read_line(&mut supplied).is_err() || supplied.trim() != expected {
                continue;
            }
            let mut pending = None;
            loop {
                let mut batch = match pending.take() {
                    Some(batch) => batch,
                    None => match receiver.recv() {
                        Ok(batch) => batch,
                        Err(_) => break,
                    },
                };
                let deadline = Instant::now() + Duration::from_millis(10);
                while let Some(timeout) = deadline.checked_duration_since(Instant::now()) {
                    match receiver.recv_timeout(timeout) {
                        Ok(next) if compatible(&batch, &next) => {
                            merge_batch(&mut batch, next);
                        }
                        Ok(next) => {
                            pending = Some(next);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                if write_batch(&mut stream, &batch).is_err() {
                    break;
                }
            }
        }
    });
    Ok((
        DataChannelInfo {
            port,
            token,
            protocol_version: 1,
        },
        sender,
    ))
}

fn write_batch(output: &mut impl Write, batch: &SampleBatch) -> io::Result<()> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"CKIT");
    payload.extend_from_slice(&batch.protocol_version.to_le_bytes());
    put_string(&mut payload, &batch.session_id);
    payload.extend_from_slice(&batch.program_generation.to_le_bytes());
    payload.extend_from_slice(&batch.stream_epoch.to_le_bytes());
    payload.extend_from_slice(&batch.batch_sequence.to_le_bytes());
    payload.extend_from_slice(&batch.sample_count.to_le_bytes());
    payload.extend_from_slice(&batch.start_timestamp_ns.to_le_bytes());
    payload.extend_from_slice(&batch.sample_period_ns.to_le_bytes());
    payload.extend_from_slice(&batch.dropped_frames.to_le_bytes());
    payload.extend_from_slice(&(batch.channel_ids.len() as u16).to_le_bytes());
    for id in &batch.channel_ids {
        put_string(&mut payload, id);
    }
    for value in &batch.values {
        payload.extend_from_slice(&value.to_le_bytes());
    }
    output.write_all(&(payload.len() as u32).to_le_bytes())?;
    output.write_all(&payload)?;
    output.flush()
}

fn put_string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u16).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

fn compatible(left: &SampleBatch, right: &SampleBatch) -> bool {
    left.protocol_version == right.protocol_version
        && left.session_id == right.session_id
        && left.program_generation == right.program_generation
        && left.stream_epoch == right.stream_epoch
        && left.channel_ids == right.channel_ids
        && right.batch_sequence == left.batch_sequence.saturating_add(1)
}

/// Join adjacent worker batches into the 10 ms transport batch. Probe reads are
/// timed from a monotonic clock, so their measured periods naturally differ by
/// a few microseconds. Requiring exact period equality prevents aggregation and
/// can overflow the bounded transport queue at otherwise modest sample rates.
/// The wire format has one period per batch, therefore use the span from the
/// first sample to the final sample as the best uniform-period approximation.
fn merge_batch(left: &mut SampleBatch, right: SampleBatch) {
    let right_last_timestamp = right.start_timestamp_ns.saturating_add(
        right
            .sample_period_ns
            .saturating_mul(u64::from(right.sample_count.saturating_sub(1))),
    );
    let combined_count = left.sample_count.saturating_add(right.sample_count);
    if combined_count > 1 && right_last_timestamp > left.start_timestamp_ns {
        left.sample_period_ns =
            (right_last_timestamp - left.start_timestamp_ns) / u64::from(combined_count - 1);
        left.sample_period_ns = left.sample_period_ns.max(1);
    }
    left.sample_count = combined_count;
    left.batch_sequence = right.batch_sequence;
    left.values.extend(right.values);
    left.dropped_frames = right.dropped_frames;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_a_framed_request() {
        let json = br#"{"seq":1,"type":"request","command":"initialize"}"#;
        let bytes = [
            format!("Content-Length: {}\r\n\r\n", json.len()).into_bytes(),
            json.to_vec(),
        ]
        .concat();
        let request = DapReader::new(bytes.as_slice())
            .next_message()
            .unwrap()
            .unwrap();
        assert_eq!(request.command.as_deref(), Some("initialize"));
    }
    #[test]
    fn encodes_binary_batch() {
        let batch = SampleBatch {
            protocol_version: 1,
            session_id: "s".into(),
            program_generation: 1,
            stream_epoch: 2,
            batch_sequence: 3,
            channel_ids: vec!["a".into()],
            sample_count: 1,
            start_timestamp_ns: 4,
            sample_period_ns: 5,
            dropped_frames: 0,
            values: vec![1.25],
        };
        let mut bytes = Vec::new();
        write_batch(&mut bytes, &batch).unwrap();
        assert_eq!(&bytes[4..8], b"CKIT");
    }

    #[test]
    fn aggregates_adjacent_batches_with_measured_period_jitter() {
        let mut left = SampleBatch {
            protocol_version: 1,
            session_id: "s".into(),
            program_generation: 1,
            stream_epoch: 2,
            batch_sequence: 3,
            channel_ids: vec!["a".into()],
            sample_count: 1,
            start_timestamp_ns: 100,
            sample_period_ns: 7,
            dropped_frames: 0,
            values: vec![1.0],
        };
        let right = SampleBatch {
            protocol_version: 1,
            session_id: "s".into(),
            program_generation: 1,
            stream_epoch: 2,
            batch_sequence: 4,
            channel_ids: vec!["a".into()],
            sample_count: 1,
            start_timestamp_ns: 120,
            sample_period_ns: 11,
            dropped_frames: 2,
            values: vec![2.0],
        };

        assert!(compatible(&left, &right));
        merge_batch(&mut left, right);

        assert_eq!(left.batch_sequence, 4);
        assert_eq!(left.sample_count, 2);
        assert_eq!(left.start_timestamp_ns, 100);
        assert_eq!(left.sample_period_ns, 20);
        assert_eq!(left.dropped_frames, 2);
        assert_eq!(left.values, vec![1.0, 2.0]);
    }

    #[test]
    fn does_not_aggregate_across_a_sequence_gap() {
        let left = SampleBatch {
            protocol_version: 1,
            session_id: "s".into(),
            program_generation: 1,
            stream_epoch: 2,
            batch_sequence: 3,
            channel_ids: vec!["a".into()],
            sample_count: 1,
            start_timestamp_ns: 100,
            sample_period_ns: 7,
            dropped_frames: 0,
            values: vec![1.0],
        };
        let mut right = left.clone();
        right.batch_sequence = 5;
        right.start_timestamp_ns = 120;

        assert!(!compatible(&left, &right));
    }
}
