use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryClass {
    Ram,
    Peripheral,
    Special,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadRequest {
    pub variable_id: String,
    pub address: u64,
    pub byte_width: u8,
    pub memory_class: MemoryClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadBlock {
    pub address: u64,
    pub byte_len: usize,
    pub memory_class: MemoryClass,
    pub variables: Vec<ReadMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadMapping {
    pub variable_id: String,
    pub offset: usize,
    pub byte_width: u8,
}

/// Build deterministic read blocks. Only normal RAM is merged; peripheral and
/// special addresses stay isolated because adjacent reads may have side effects.
pub fn plan_reads(requests: &[ReadRequest], max_ram_gap: usize) -> Vec<ReadBlock> {
    let mut ordered = requests.to_vec();
    ordered.sort_by_key(|request| (request.memory_class as u8, request.address));
    ordered.dedup_by(|right, left| {
        right.address == left.address
            && right.byte_width == left.byte_width
            && right.memory_class == left.memory_class
            && right.variable_id == left.variable_id
    });

    let mut blocks: Vec<ReadBlock> = Vec::new();
    for request in ordered {
        let start = request.address & !3;
        let end = request
            .address
            .saturating_add(u64::from(request.byte_width))
            .saturating_add(3)
            & !3;
        let can_merge = request.memory_class == MemoryClass::Ram;
        if let Some(block) = blocks.last_mut() {
            let block_end = block.address.saturating_add(block.byte_len as u64);
            if can_merge
                && block.memory_class == MemoryClass::Ram
                && start <= block_end.saturating_add(max_ram_gap as u64)
            {
                block.byte_len = end.max(block_end).saturating_sub(block.address) as usize;
                block.variables.push(ReadMapping {
                    variable_id: request.variable_id,
                    offset: request.address.saturating_sub(block.address) as usize,
                    byte_width: request.byte_width,
                });
                continue;
            }
        }
        blocks.push(ReadBlock {
            address: start,
            byte_len: end.saturating_sub(start) as usize,
            memory_class: request.memory_class,
            variables: vec![ReadMapping {
                variable_id: request.variable_id,
                offset: request.address.saturating_sub(start) as usize,
                byte_width: request.byte_width,
            }],
        });
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_ram_but_not_peripherals() {
        let blocks = plan_reads(
            &[
                ReadRequest {
                    variable_id: "a".into(),
                    address: 0x2000,
                    byte_width: 4,
                    memory_class: MemoryClass::Ram,
                },
                ReadRequest {
                    variable_id: "b".into(),
                    address: 0x2004,
                    byte_width: 4,
                    memory_class: MemoryClass::Ram,
                },
                ReadRequest {
                    variable_id: "r1".into(),
                    address: 0x4000,
                    byte_width: 4,
                    memory_class: MemoryClass::Peripheral,
                },
                ReadRequest {
                    variable_id: "r2".into(),
                    address: 0x4004,
                    byte_width: 4,
                    memory_class: MemoryClass::Peripheral,
                },
            ],
            0,
        );
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].byte_len, 8);
        assert_eq!(blocks[0].variables.len(), 2);
    }
}
