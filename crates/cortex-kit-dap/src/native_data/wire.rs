//! CKIT v1 ingress, plus bounded little-endian length-prefixed JSON RPC.
use cortex_kit_core::SampleBatch;
use serde_json::Value;
use std::{collections::HashSet, io::{self, Read, Write}};
pub const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_COMMAND_BYTES: usize = 512 * 1024;
pub const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;
fn invalid(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
pub fn read_json(input: &mut impl Read, limit: usize) -> io::Result<Option<Value>> {
    let mut header = [0; 4];
    // EOF only at a frame boundary is normal; truncated headers are errors.
    match input.read(&mut header[..1])? { 0 => return Ok(None), _ => input.read_exact(&mut header[1..])? }
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > limit { return Err(invalid("RPC frame size exceeds limit")); }
    let mut data = vec![0; length]; input.read_exact(&mut data)?;
    serde_json::from_slice(&data).map(Some).map_err(|e| invalid(&e.to_string()))
}
pub fn write_json(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(message)?;
    if payload.len() > MAX_REPLY_BYTES { return Err(invalid("RPC reply exceeds bounded output limit")); }
    output.write_all(&(payload.len() as u32).to_le_bytes())?; output.write_all(&payload)?; output.flush()
}
struct Cursor<'a> { bytes: &'a [u8], offset: usize }
impl<'a> Cursor<'a> {
    fn take(&mut self, size: usize) -> io::Result<&'a [u8]> {
        let end = self.offset.checked_add(size).ok_or_else(|| invalid("field length overflow"))?;
        let value = self.bytes.get(self.offset..end).ok_or_else(|| invalid("truncated CKIT packet"))?;
        self.offset = end; Ok(value)
    }
    fn u16(&mut self) -> io::Result<u16> { Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
    fn u32(&mut self) -> io::Result<u32> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> io::Result<u64> { Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn text(&mut self) -> io::Result<String> {
        let len = self.u16()? as usize; if len == 0 || len > 4096 { return Err(invalid("CKIT identifier length invalid")); }
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| invalid("CKIT identifier is not UTF-8"))
    }
}
pub fn decode(payload: &[u8]) -> io::Result<SampleBatch> {
    let mut c = Cursor { bytes: payload, offset: 0 };
    if c.take(4)? != b"CKIT" || c.u16()? != 1 { return Err(invalid("unsupported CKIT protocol")); }
    let session_id = c.text()?; let program_generation = c.u64()?; let stream_epoch = c.u64()?;
    let batch_sequence = c.u64()?; let sample_count = c.u32()?; let start_timestamp_ns = c.u64()?;
    let sample_period_ns = c.u64()?; let dropped_frames = c.u64()?; let width = c.u16()? as usize;
    if width == 0 || width > 256 || sample_count == 0 { return Err(invalid("invalid CKIT dimensions")); }
    if sample_count > 1 && sample_period_ns == 0 { return Err(invalid("multi-sample batch has zero period")); }
    start_timestamp_ns.checked_add(sample_period_ns.checked_mul(u64::from(sample_count - 1))
        .ok_or_else(|| invalid("timestamp overflow"))?).ok_or_else(|| invalid("timestamp overflow"))?;
    let mut channel_ids = Vec::with_capacity(width); let mut seen = HashSet::new();
    for _ in 0..width { let id = c.text()?; if !seen.insert(id.clone()) { return Err(invalid("duplicate CKIT channel")); } channel_ids.push(id); }
    let count = width.checked_mul(sample_count as usize).ok_or_else(|| invalid("value count overflow"))?;
    let bytes = count.checked_mul(8).ok_or_else(|| invalid("value byte count overflow"))?;
    if bytes != payload.len() - c.offset { return Err(invalid("CKIT value count mismatch")); }
    let values = c.take(bytes)?.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    Ok(SampleBatch { protocol_version: 1, session_id, program_generation, stream_epoch, batch_sequence,
        sample_count, start_timestamp_ns, sample_period_ns, dropped_frames, channel_ids, values })
}
#[derive(Default)]
pub struct Decoder { bytes: Vec<u8>, head: usize }
impl Decoder {
    pub fn push(&mut self, data: &[u8]) -> io::Result<Vec<SampleBatch>> {
        if self.bytes.len() + data.len() > MAX_BATCH_BYTES + 65540 { return Err(invalid("CKIT ingress buffer limit exceeded")); }
        self.bytes.extend_from_slice(data); let mut out = Vec::new();
        while self.bytes.len() - self.head >= 4 {
            let size = u32::from_le_bytes(self.bytes[self.head..self.head + 4].try_into().unwrap()) as usize;
            if size == 0 || size > MAX_BATCH_BYTES { return Err(invalid("CKIT packet length exceeds limit")); }
            if self.bytes.len() - self.head - 4 < size { break; }
            out.push(decode(&self.bytes[self.head + 4..self.head + 4 + size])?); self.head += 4 + size;
        }
        if self.head == self.bytes.len() { self.bytes.clear(); self.head = 0; }
        else if self.head > 0 { self.bytes.copy_within(self.head.., 0); self.bytes.truncate(self.bytes.len() - self.head); self.head = 0; }
        Ok(out)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    fn packet() -> Vec<u8> {
        let mut p = b"CKIT".to_vec(); p.extend(1u16.to_le_bytes()); p.extend(1u16.to_le_bytes()); p.push(b's');
        for n in [1u64,2,3] { p.extend(n.to_le_bytes()); } p.extend(2u32.to_le_bytes());
        for n in [100u64,10,0] { p.extend(n.to_le_bytes()); }
        p.extend(1u16.to_le_bytes()); p.extend(1u16.to_le_bytes()); p.push(b'a');
        p.extend(1.25f64.to_le_bytes()); p.extend((-4.0f64).to_le_bytes());
        let mut frame = (p.len() as u32).to_le_bytes().to_vec(); frame.extend(p); frame
    }
    #[test] fn every_byte_split_preserves_values() {
        let mut d = Decoder::default(); let mut output = Vec::new();
        for byte in packet() { output.extend(d.push(&[byte]).unwrap()); }
        assert_eq!(output.len(), 1); assert_eq!(output[0].values, [1.25,-4.0]); assert_eq!(output[0].start_timestamp_ns,100);
    }
    #[test] fn malformed_and_oversize_are_rejected() {
        let mut p = packet(); p[4] = b'X'; assert!(Decoder::default().push(&p).is_err());
        assert!(Decoder::default().push(&u32::MAX.to_le_bytes()).is_err());
        assert!(read_json(&mut &[2,0,0][..], 100).is_err());
    }
    #[test] fn json_roundtrip_and_clean_eof() {
        let value = serde_json::json!({"id":2,"method":"latest"}); let mut bytes = Vec::new(); write_json(&mut bytes,&value).unwrap();
        assert_eq!(read_json(&mut bytes.as_slice(), 1000).unwrap(),Some(value)); assert!(read_json(&mut &[][..],100).unwrap().is_none());
    }
}
