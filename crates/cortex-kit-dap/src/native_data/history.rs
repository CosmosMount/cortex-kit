//! Bounded, display-only history. The raw recorder never reads this ring.
use serde::Serialize;
const BLOCK: usize = 32;

#[derive(Clone, Copy, Default)]
pub struct Point { pub t: u64, pub value: f64, pub segment: u64 }
#[derive(Clone, Copy)]
struct Summary { min: f64, max: f64, count: usize, segment: u64, mixed: bool }
impl Default for Summary {
    fn default() -> Self { Self { min: f64::INFINITY, max: f64::NEG_INFINITY, count: 0, segment: 0, mixed: false } }
}
impl Summary {
    fn add(&mut self, other: Self) {
        if other.count == 0 { return; }
        if self.count == 0 { *self = other; return; }
        self.min = self.min.min(other.min); self.max = self.max.max(other.max);
        self.mixed |= other.mixed || self.segment != other.segment;
        self.count += other.count;
    }
    fn point(p: Point) -> Self {
        if !p.value.is_finite() { return Self::default(); }
        Self { min: p.value, max: p.value, count: 1, segment: p.segment, mixed: false }
    }
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub low: Option<f64>, pub high: Option<f64>,
    /// [minimum, maximum, segment]; null is empty, segment -1 is mixed.
    pub bins: Vec<Option<[f64; 3]>>,
}
pub struct History {
    points: Vec<Point>, tree: Vec<Summary>, leaves: usize,
    head: usize, len: usize, segment: u64, epoch: Option<u64>, break_next: bool,
    pub revision: u64, pub evicted: u64, pub rejected: u64,
}
impl History {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.clamp(BLOCK, 1 << 20).next_power_of_two();
        Self { points: vec![Point::default(); capacity], tree: vec![Summary::default(); capacity / BLOCK * 2],
            leaves: capacity / BLOCK, head: 0, len: 0, segment: 1, epoch: None,
            break_next: false, revision: 0, evicted: 0, rejected: 0 }
    }
    pub fn capacity(&self) -> usize { self.points.len() }
    pub fn len(&self) -> usize { self.len }
    fn physical(&self, index: usize) -> usize { (self.head + index) & (self.capacity() - 1) }
    pub fn point(&self, index: usize) -> Point { self.points[self.physical(index)] }
    pub fn last(&self) -> Option<Point> { self.len.checked_sub(1).map(|i| self.point(i)) }
    pub fn mark_gap(&mut self) { self.break_next = true; }
    pub fn push(&mut self, t: u64, value: f64, epoch: u64) {
        if self.last().is_some_and(|p| t < p.t) { self.rejected += 1; self.break_next = true; return; }
        if self.break_next || self.epoch.is_some_and(|e| e != epoch) { self.segment += 1; }
        self.epoch = Some(epoch); self.break_next = !value.is_finite();
        if self.len == self.capacity() { self.head = self.physical(1); self.len -= 1; self.evicted += 1; }
        let p = self.physical(self.len); self.points[p] = Point { t, value, segment: self.segment };
        self.len += 1; self.revision += 1;
        // Partly overwritten blocks never use stale tree summaries: reduce()
        // scans both partial physical edges, and only queries complete blocks.
        if (p + 1) % BLOCK == 0 {
            let mut node = self.leaves + p / BLOCK;
            let mut s = Summary::default();
            for point in &self.points[p + 1 - BLOCK..=p] { s.add(Summary::point(*point)); }
            self.tree[node] = s;
            while node > 1 { node /= 2; let mut s = self.tree[node * 2]; s.add(self.tree[node * 2 + 1]); self.tree[node] = s; }
        }
    }
    fn lower_bound(&self, t: u64, upper: bool) -> usize {
        let (mut lo, mut hi) = (0, self.len);
        while lo < hi { let mid = (lo + hi) / 2; let x = self.point(mid).t;
            if x < t || (upper && x == t) { lo = mid + 1; } else { hi = mid; } }
        lo
    }
    pub fn trim(&mut self, cutoff: u64) {
        let n = self.lower_bound(cutoff, false);
        if n > 0 { self.head = self.physical(n); self.len -= n; self.revision += 1; }
    }
    pub fn resized(&self, capacity: usize) -> Self {
        let mut new = Self::new(capacity);
        let first = self.len.saturating_sub(new.capacity());
        // Preserve segment boundaries, not the original (possibly repeated) epoch.
        for i in first..self.len { let p = self.point(i); new.push(p.t, p.value, p.segment); }
        new.evicted = self.evicted + first as u64; new.rejected = self.rejected;
        new.epoch = self.epoch; new.break_next = true; new.revision = self.revision + 1; new
    }
    fn reduce_physical(&self, mut first: usize, end: usize, out: &mut Summary) {
        while first < end && first % BLOCK != 0 { out.add(Summary::point(self.points[first])); first += 1; }
        let aligned = end - end % BLOCK;
        if aligned > first {
            let (mut left, mut right) = (self.leaves + first / BLOCK, self.leaves + aligned / BLOCK);
            while left < right {
                if left & 1 == 1 { out.add(self.tree[left]); left += 1; }
                if right & 1 == 1 { right -= 1; out.add(self.tree[right]); }
                left /= 2; right /= 2;
            }
            first = aligned;
        }
        while first < end { out.add(Summary::point(self.points[first])); first += 1; }
    }
    fn reduce(&self, first: usize, end: usize) -> Summary {
        let mut out = Summary::default();
        if first >= end { return out; }
        let p = self.physical(first); let count = end - first;
        self.reduce_physical(p, self.capacity().min(p + count), &mut out);
        if p + count > self.capacity() { self.reduce_physical(0, p + count - self.capacity(), &mut out); }
        out
    }
    pub fn envelope(&self, start: i128, end: u64, columns: usize) -> Envelope {
        let columns = columns.clamp(1, 4096);
        let mut out = Envelope { low: None, high: None, bins: vec![None; columns] };
        if (end as i128) < start || self.len == 0 { return out; }
        let first = self.lower_bound(start.max(0) as u64, false); let last = self.lower_bound(end, true);
        let span = ((end as i128 - start).max(1)) as u128;
        let bin_of = |i: usize| -> usize {
            (((self.point(i).t as i128 - start) as u128 * columns as u128 / span) as usize).min(columns - 1)
        };
        let mut lo = first;
        for b in 0..columns {
            if lo == last { break; }
            let (mut left, mut right) = (lo, last);
            if b == columns - 1 { left = last; }
            else { while left < right { let mid = (left + right) / 2;
                if bin_of(mid) <= b { left = mid + 1; } else { right = mid; } } }
            let s = self.reduce(lo, left); lo = left;
            if s.count > 0 {
                out.low = Some(out.low.map_or(s.min, |v| v.min(s.min)));
                out.high = Some(out.high.map_or(s.max, |v| v.max(s.max)));
                out.bins[b] = Some([s.min, s.max, if s.mixed { -1.0 } else { s.segment as f64 }]);
            }
        }
        out
    }
    pub fn fft_input(&self) -> Option<(Vec<f64>, f64, u64)> {
        let last = self.last()?;
        if !last.value.is_finite() { return None; }
        let mut count = 0;
        while count < self.len.min(65536) { let p = self.point(self.len - 1 - count);
            if p.segment != last.segment || !p.value.is_finite() { break; } count += 1; }
        if count < 16 { return None; }
        let n = 1usize << (usize::BITS - 1 - count.leading_zeros());
        let first = self.len - n; let period = (last.t - self.point(first).t) as f64 / (n - 1) as f64 / 1e9;
        if period <= 0.0 { return None; }
        Some(((first..self.len).map(|i| self.point(i).value).collect(), period, last.segment))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check(h: &History, start: u64, end: u64, width: usize) {
        let actual = h.envelope(start as i128, end, width);
        let mut bins = vec![Summary::default(); width];
        for i in 0..h.len() { let p = h.point(i); if p.t < start || p.t > end { continue; }
            let b = ((u128::from(p.t - start) * width as u128 / u128::from((end - start).max(1))) as usize).min(width - 1);
            bins[b].add(Summary::point(p)); }
        for (a, b) in actual.bins.iter().zip(bins) {
            if b.count == 0 { assert!(a.is_none()); }
            else { assert_eq!(*a, Some([b.min, b.max, if b.mixed { -1.0 } else { b.segment as f64 }])); }
        }
    }
    #[test] fn wrapping_partial_blocks_match_reference() {
        let mut h = History::new(256);
        for i in 0..4000u64 { h.push(i, (i as f64).sin(), i / 317);
            if i % 19 == 0 { for width in [1, 3, 17, 400] { check(&h, i.saturating_sub(203), i, width); } } }
        assert_eq!(h.len(), 256); assert_eq!(h.evicted, 3744);
    }
    #[test] fn spikes_gaps_and_trim_are_preserved() {
        let mut h = History::new(1024);
        for i in 0..1000 { h.push(i, if i == 301 { 9000.0 } else if i == 302 { f64::NAN } else { 0.0 }, 1); }
        assert_eq!(h.envelope(0, 999, 8).high, Some(9000.0)); check(&h, 0, 999, 8);
        assert_eq!(h.envelope(0, 999, 1).bins[0].unwrap()[2], -1.0);
        h.trim(900); assert_eq!(h.len(), 100); h.trim(0); assert_eq!(h.len(), 100);
    }
    #[test] fn backward_timestamp_does_not_poison_index() {
        let mut h = History::new(32); h.push(10, 1.0, 1); h.push(9, 2.0, 1); h.push(11, 3.0, 1);
        assert_eq!(h.len(), 2); assert_eq!(h.rejected, 1); assert_ne!(h.point(0).segment, h.point(1).segment);
    }
    #[test] fn fft_never_spans_a_gap() {
        let mut h = History::new(256); for i in 0..128 { if i == 90 { h.mark_gap(); } h.push(i * 1000, i as f64, 1); }
        let (data, period, _) = h.fft_input().unwrap(); assert_eq!(data.len(), 32); assert_eq!(data[0], 96.0);
        assert!((period - 1e-6).abs() < 1e-12);
    }
}
