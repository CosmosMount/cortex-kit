use crossbeam_queue::ArrayQueue;

/// Bounded concurrent queue. When full, the oldest entry is replaced so a slow
/// renderer can never stall the probe worker.
pub struct RingBuffer<T> {
    queue: ArrayQueue<T>,
}

impl<T> RingBuffer<T> {
    pub fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0, "ring buffer capacity must be non-zero");
        Self {
            queue: ArrayQueue::new(capacity),
        }
    }

    pub fn push(&self, value: T) -> bool {
        self.queue.force_push(value).is_some()
    }

    pub fn drain_into(&self, output: &mut Vec<T>) -> usize {
        output.clear();
        let available = self.queue.len();
        output.reserve(available);
        for _ in 0..available {
            match self.queue.pop() {
                Some(value) => output.push(value),
                None => break,
            }
        }
        output.len()
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::RingBuffer;

    #[test]
    fn replaces_oldest_when_full() {
        let queue = RingBuffer::with_capacity(2);
        assert!(!queue.push(1));
        assert!(!queue.push(2));
        assert!(queue.push(3));
        let mut values = Vec::new();
        queue.drain_into(&mut values);
        assert_eq!(values, vec![2, 3]);
    }
}
