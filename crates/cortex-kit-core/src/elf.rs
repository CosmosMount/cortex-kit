use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use anyhow::{Context, Result};
use gimli::{
    AttributeValue, DebuggingInformationEntry, Dwarf, EndianSlice, Reader, ReaderOffset,
    RunTimeEndian, Unit, constants,
};
use object::{Object, ObjectSymbol, SymbolKind};

use crate::{ScalarKind, VariableDescriptor, dwarf_lines::load_dwarf};

#[derive(Debug, Clone)]
struct SymbolRecord {
    name: String,
    address: u64,
    size: u64,
}

#[derive(Debug, Clone)]
struct RawDie {
    tag: gimli::DwTag,
    name: Option<String>,
    linkage_name: Option<String>,
    type_ref: Option<usize>,
    byte_size: Option<u64>,
    encoding: Option<gimli::DwAte>,
    member_offset: u64,
    count: Option<u64>,
    location: Option<u64>,
    declaration: bool,
    is_const: bool,
    bit_size: Option<u64>,
    children: Vec<usize>,
}

/// Build a typed global/static variable catalog directly from ELF/AXF DWARF.
/// If usable DWARF is unavailable, data symbols remain available as untyped
/// scalar values so an external GNU toolchain is never required at runtime.
pub fn load_elf_data_symbols(path: impl AsRef<Path>) -> Result<Vec<VariableDescriptor>> {
    let path = path.as_ref();
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let file = object::File::parse(bytes.as_slice()).context("parse ELF/AXF object")?;
    let symbols = data_symbols(&file);
    let mut variables = typed_variables(&file, &symbols).unwrap_or_default();
    let existing = variables
        .iter()
        .filter_map(|item| item.address.map(|address| (item.name.clone(), address)))
        .collect::<HashSet<_>>();
    for symbol in symbols {
        if existing.contains(&(symbol.name.clone(), symbol.address)) {
            continue;
        }
        let byte_width = symbol.size.clamp(1, 8) as u8;
        variables.push(VariableDescriptor {
            id: format!("elf:{:x}:{}", symbol.address, symbol.name),
            name: symbol.name.clone(),
            expression: symbol.name,
            type_name: format!("data[{byte_width}]"),
            address: Some(symbol.address),
            byte_width,
            scalar_kind: ScalarKind::Unsigned,
            writable: true,
            children: Vec::new(),
        });
    }
    variables.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.address.cmp(&right.address))
    });
    variables.dedup_by(|left, right| left.name == right.name && left.address == right.address);
    Ok(variables)
}

fn data_symbols(file: &object::File<'_>) -> Vec<SymbolRecord> {
    let mut symbols = Vec::new();
    for symbol in file.symbols() {
        if symbol.kind() != SymbolKind::Data || symbol.is_undefined() || symbol.address() == 0 {
            continue;
        }
        let Ok(name) = symbol.name() else { continue };
        if !name.is_empty() {
            symbols.push(SymbolRecord {
                name: name.to_owned(),
                address: symbol.address(),
                size: symbol.size(),
            });
        }
    }
    symbols
}

fn typed_variables(
    object: &object::File<'_>,
    symbols: &[SymbolRecord],
) -> Result<Vec<VariableDescriptor>> {
    let endian = match object.endianness() {
        object::Endianness::Little => RunTimeEndian::Little,
        object::Endianness::Big => RunTimeEndian::Big,
    };
    let dwarf = load_dwarf(object, endian)?;
    let mut dies = HashMap::new();
    let mut variables = Vec::new();
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        collect_unit(&dwarf, &unit, &mut dies, &mut variables)?;
    }

    let symbols_by_name = symbols
        .iter()
        .map(|symbol| (symbol.name.as_str(), symbol))
        .collect::<HashMap<_, _>>();
    let mut result = Vec::new();
    for key in variables {
        let Some(variable) = dies.get(&key) else {
            continue;
        };
        if variable.declaration {
            continue;
        }
        let Some(name) = variable.name.as_deref() else {
            continue;
        };
        let symbol = variable
            .linkage_name
            .as_deref()
            .and_then(|value| symbols_by_name.get(value).copied())
            .or_else(|| symbols_by_name.get(name).copied());
        let Some(address) = variable
            .location
            .or_else(|| symbol.map(|item| item.address))
        else {
            continue;
        };
        let fallback_size = symbol.map(|item| item.size).unwrap_or(1).max(1);
        let descriptor = match variable.type_ref {
            Some(type_key) => descriptor_for_type(
                &dies,
                type_key,
                name,
                name,
                address,
                true,
                fallback_size,
                0,
                &mut HashSet::new(),
            ),
            None => scalar_descriptor(
                name,
                name,
                address,
                fallback_size,
                ScalarKind::Unsigned,
                "data",
                true,
            ),
        };
        result.push(descriptor);
    }
    Ok(result)
}

fn collect_unit<'a>(
    dwarf: &Dwarf<EndianSlice<'a, RunTimeEndian>>,
    unit: &Unit<EndianSlice<'a, RunTimeEndian>>,
    dies: &mut HashMap<usize, RawDie>,
    variables: &mut Vec<usize>,
) -> Result<()> {
    let mut entries = unit.entries();
    let mut depth = 0_isize;
    let mut parents = Vec::<usize>::new();
    while let Some((delta, entry)) = entries.next_dfs()? {
        depth += delta;
        let Some(key) = entry
            .offset()
            .to_debug_info_offset(&unit.header)
            .map(|offset| offset.0)
        else {
            continue;
        };
        let raw = raw_die(dwarf, unit, entry)?;
        if entry.tag() == constants::DW_TAG_variable {
            variables.push(key);
        }
        let parent_depth = depth.max(0) as usize;
        if parent_depth > 0 {
            if let Some(parent) = parents.get(parent_depth - 1).copied() {
                if let Some(parent) = dies.get_mut(&parent) {
                    parent.children.push(key);
                }
            }
        }
        dies.insert(key, raw);
        parents.truncate(parent_depth);
        parents.push(key);
    }
    Ok(())
}

fn raw_die<'a>(
    dwarf: &Dwarf<EndianSlice<'a, RunTimeEndian>>,
    unit: &Unit<EndianSlice<'a, RunTimeEndian>>,
    entry: &DebuggingInformationEntry<'_, '_, EndianSlice<'a, RunTimeEndian>>,
) -> Result<RawDie> {
    let name = entry
        .attr_value(constants::DW_AT_name)?
        .and_then(|value| dwarf_string(dwarf, unit, value));
    let linkage_name = entry
        .attr_value(constants::DW_AT_linkage_name)?
        .or(entry.attr_value(constants::DW_AT_MIPS_linkage_name)?)
        .and_then(|value| dwarf_string(dwarf, unit, value));
    let type_ref = entry
        .attr_value(constants::DW_AT_type)?
        .and_then(|value| reference_key(value, unit));
    let byte_size = entry
        .attr_value(constants::DW_AT_byte_size)?
        .and_then(|value| value.udata_value());
    let encoding = match entry.attr_value(constants::DW_AT_encoding)? {
        Some(AttributeValue::Encoding(value)) => Some(value),
        _ => None,
    };
    let member_offset = entry
        .attr_value(constants::DW_AT_data_member_location)?
        .and_then(attribute_u64)
        .unwrap_or(0);
    let count = entry
        .attr_value(constants::DW_AT_count)?
        .and_then(attribute_u64)
        .or_else(|| {
            entry
                .attr_value(constants::DW_AT_upper_bound)
                .ok()
                .flatten()
                .and_then(attribute_u64)
                .map(|upper| upper.saturating_add(1))
        });
    let location = entry
        .attr_value(constants::DW_AT_location)?
        .and_then(|value| location_address(value, unit));
    let declaration = matches!(
        entry.attr_value(constants::DW_AT_declaration)?,
        Some(AttributeValue::Flag(true))
    );
    let bit_size = entry
        .attr_value(constants::DW_AT_bit_size)?
        .and_then(attribute_u64);
    Ok(RawDie {
        tag: entry.tag(),
        name,
        linkage_name,
        type_ref,
        byte_size,
        encoding,
        member_offset,
        count,
        location,
        declaration,
        is_const: entry.tag() == constants::DW_TAG_const_type,
        bit_size,
        children: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
fn descriptor_for_type(
    dies: &HashMap<usize, RawDie>,
    key: usize,
    name: &str,
    expression: &str,
    address: u64,
    writable: bool,
    fallback_size: u64,
    depth: usize,
    visiting: &mut HashSet<usize>,
) -> VariableDescriptor {
    if depth >= 24 || !visiting.insert(key) {
        return scalar_descriptor(
            name,
            expression,
            address,
            fallback_size,
            ScalarKind::Unsigned,
            "recursive type",
            false,
        );
    }
    let Some(die) = dies.get(&key) else {
        visiting.remove(&key);
        return scalar_descriptor(
            name,
            expression,
            address,
            fallback_size,
            ScalarKind::Unsigned,
            "unknown",
            writable,
        );
    };
    let size = type_size(dies, key, &mut HashSet::new())
        .unwrap_or(fallback_size)
        .max(1);
    let next_writable = writable && !die.is_const;
    let mut result = match die.tag {
        constants::DW_TAG_typedef
        | constants::DW_TAG_const_type
        | constants::DW_TAG_volatile_type
        | constants::DW_TAG_restrict_type
        | constants::DW_TAG_atomic_type => match die.type_ref {
            Some(next) => {
                let mut value = descriptor_for_type(
                    dies,
                    next,
                    name,
                    expression,
                    address,
                    next_writable,
                    size,
                    depth + 1,
                    visiting,
                );
                if let Some(alias) = die.name.as_deref() {
                    value.type_name = alias.to_owned();
                }
                value
            }
            None => scalar_descriptor(
                name,
                expression,
                address,
                size,
                ScalarKind::Unsigned,
                die.name.as_deref().unwrap_or("qualified type"),
                next_writable,
            ),
        },
        constants::DW_TAG_structure_type
        | constants::DW_TAG_class_type
        | constants::DW_TAG_union_type => {
            let mut children = Vec::new();
            for child_key in &die.children {
                let Some(member) = dies.get(child_key) else {
                    continue;
                };
                if member.tag != constants::DW_TAG_member || member.bit_size.is_some() {
                    continue;
                }
                let (Some(member_name), Some(member_type)) =
                    (member.name.as_deref(), member.type_ref)
                else {
                    continue;
                };
                let offset = if die.tag == constants::DW_TAG_union_type {
                    0
                } else {
                    member.member_offset
                };
                children.push(descriptor_for_type(
                    dies,
                    member_type,
                    member_name,
                    &format!("{expression}.{member_name}"),
                    address.saturating_add(offset),
                    next_writable,
                    1,
                    depth + 1,
                    visiting,
                ));
            }
            aggregate_descriptor(
                name,
                expression,
                address,
                size,
                die.name.as_deref().unwrap_or("anonymous struct"),
                next_writable,
                children,
            )
        }
        constants::DW_TAG_array_type => {
            let element_key = die.type_ref;
            let dimensions = die
                .children
                .iter()
                .filter_map(|child| dies.get(child))
                .filter(|child| child.tag == constants::DW_TAG_subrange_type)
                .filter_map(|child| child.count)
                .collect::<Vec<_>>();
            let element_size = element_key
                .and_then(|next| type_size(dies, next, &mut HashSet::new()))
                .unwrap_or(1)
                .max(1);
            let children = element_key
                .map(|next| {
                    array_children(
                        dies,
                        next,
                        &dimensions,
                        0,
                        expression,
                        address,
                        next_writable,
                        element_size,
                        depth + 1,
                        visiting,
                    )
                })
                .unwrap_or_default();
            let count = dimensions.iter().copied().product::<u64>();
            aggregate_descriptor(
                name,
                expression,
                address,
                size,
                &format!("array[{count}]"),
                next_writable,
                children,
            )
        }
        constants::DW_TAG_pointer_type => scalar_descriptor(
            name,
            expression,
            address,
            size,
            ScalarKind::Unsigned,
            die.name.as_deref().unwrap_or("pointer"),
            next_writable,
        ),
        constants::DW_TAG_enumeration_type => scalar_descriptor(
            name,
            expression,
            address,
            size,
            ScalarKind::Signed,
            die.name.as_deref().unwrap_or("enum"),
            next_writable,
        ),
        _ => scalar_descriptor(
            name,
            expression,
            address,
            size,
            scalar_kind(die.encoding, size),
            die.name.as_deref().unwrap_or("scalar"),
            next_writable,
        ),
    };
    result.id = format!("dwarf:{address:x}:{expression}");
    visiting.remove(&key);
    result
}

#[allow(clippy::too_many_arguments)]
fn array_children(
    dies: &HashMap<usize, RawDie>,
    element_key: usize,
    dimensions: &[u64],
    dimension: usize,
    expression: &str,
    address: u64,
    writable: bool,
    element_size: u64,
    depth: usize,
    visiting: &mut HashSet<usize>,
) -> Vec<VariableDescriptor> {
    let count = dimensions.get(dimension).copied().unwrap_or(0).min(4096);
    let remaining_stride = dimensions
        .get(dimension + 1..)
        .unwrap_or_default()
        .iter()
        .copied()
        .product::<u64>()
        .max(1)
        .saturating_mul(element_size);
    (0..count)
        .map(|index| {
            let child_expression = format!("{expression}[{index}]");
            let child_address = address.saturating_add(index.saturating_mul(remaining_stride));
            if dimension + 1 < dimensions.len() {
                let children = array_children(
                    dies,
                    element_key,
                    dimensions,
                    dimension + 1,
                    &child_expression,
                    child_address,
                    writable,
                    element_size,
                    depth + 1,
                    visiting,
                );
                aggregate_descriptor(
                    &format!("[{index}]"),
                    &child_expression,
                    child_address,
                    remaining_stride,
                    "array",
                    writable,
                    children,
                )
            } else {
                descriptor_for_type(
                    dies,
                    element_key,
                    &format!("[{index}]"),
                    &child_expression,
                    child_address,
                    writable,
                    element_size,
                    depth + 1,
                    visiting,
                )
            }
        })
        .collect()
}

fn scalar_descriptor(
    name: &str,
    expression: &str,
    address: u64,
    byte_size: u64,
    scalar_kind: ScalarKind,
    type_name: &str,
    writable: bool,
) -> VariableDescriptor {
    VariableDescriptor {
        id: format!("dwarf:{address:x}:{expression}"),
        name: name.to_owned(),
        expression: expression.to_owned(),
        type_name: type_name.to_owned(),
        address: Some(address),
        byte_width: byte_size.clamp(1, u8::MAX as u64) as u8,
        scalar_kind,
        writable,
        children: Vec::new(),
    }
}

fn aggregate_descriptor(
    name: &str,
    expression: &str,
    address: u64,
    byte_size: u64,
    type_name: &str,
    writable: bool,
    children: Vec<VariableDescriptor>,
) -> VariableDescriptor {
    VariableDescriptor {
        id: format!("dwarf:{address:x}:{expression}"),
        name: name.to_owned(),
        expression: expression.to_owned(),
        type_name: type_name.to_owned(),
        address: Some(address),
        byte_width: byte_size.clamp(1, u8::MAX as u64) as u8,
        scalar_kind: ScalarKind::Unsigned,
        writable,
        children,
    }
}

fn type_size(
    dies: &HashMap<usize, RawDie>,
    key: usize,
    visiting: &mut HashSet<usize>,
) -> Option<u64> {
    if !visiting.insert(key) {
        return None;
    }
    let die = dies.get(&key)?;
    let size = die.byte_size.or_else(|| {
        if die.tag == constants::DW_TAG_array_type {
            let count = die
                .children
                .iter()
                .filter_map(|child| dies.get(child)?.count)
                .product::<u64>()
                .max(1);
            die.type_ref
                .and_then(|next| type_size(dies, next, visiting))
                .map(|element| element.saturating_mul(count))
        } else {
            die.type_ref
                .and_then(|next| type_size(dies, next, visiting))
        }
    });
    visiting.remove(&key);
    size
}

fn scalar_kind(encoding: Option<gimli::DwAte>, size: u64) -> ScalarKind {
    match encoding {
        Some(constants::DW_ATE_float) if size == 4 => ScalarKind::Float32,
        Some(constants::DW_ATE_float) if size == 8 => ScalarKind::Float64,
        Some(constants::DW_ATE_boolean) => ScalarKind::Boolean,
        Some(constants::DW_ATE_signed | constants::DW_ATE_signed_char) => ScalarKind::Signed,
        _ => ScalarKind::Unsigned,
    }
}

fn reference_key<R: Reader>(value: AttributeValue<R>, unit: &Unit<R>) -> Option<usize> {
    match value {
        AttributeValue::UnitRef(offset) => offset
            .to_debug_info_offset(&unit.header)
            .map(|offset| offset.0.into_u64() as usize),
        AttributeValue::DebugInfoRef(offset) => Some(offset.0.into_u64() as usize),
        _ => None,
    }
}

fn dwarf_string<'a>(
    dwarf: &Dwarf<EndianSlice<'a, RunTimeEndian>>,
    unit: &Unit<EndianSlice<'a, RunTimeEndian>>,
    value: AttributeValue<EndianSlice<'a, RunTimeEndian>>,
) -> Option<String> {
    dwarf
        .attr_string(unit, value)
        .ok()?
        .to_slice()
        .ok()
        .map(|bytes| String::from_utf8_lossy(bytes.as_ref()).into_owned())
}

fn attribute_u64<R: Reader>(value: AttributeValue<R>) -> Option<u64> {
    value.udata_value().or_else(|| match value {
        AttributeValue::Sdata(value) if value >= 0 => Some(value as u64),
        _ => None,
    })
}

fn location_address<R: Reader>(value: AttributeValue<R>, unit: &Unit<R>) -> Option<u64> {
    match value {
        AttributeValue::Addr(address) => Some(address),
        AttributeValue::Exprloc(expression) => {
            let mut operations = expression.operations(unit.encoding());
            while let Ok(Some(operation)) = operations.next() {
                if let gimli::Operation::Address { address } = operation {
                    return Some(address);
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(tag: gimli::DwTag) -> RawDie {
        RawDie {
            tag,
            name: None,
            linkage_name: None,
            type_ref: None,
            byte_size: None,
            encoding: None,
            member_offset: 0,
            count: None,
            location: None,
            declaration: false,
            is_const: false,
            bit_size: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn expands_struct_members_into_plottable_addresses() {
        let mut dies = HashMap::new();
        let mut float = raw(constants::DW_TAG_base_type);
        float.name = Some("float".into());
        float.byte_size = Some(4);
        float.encoding = Some(constants::DW_ATE_float);
        dies.insert(1, float);

        let mut first = raw(constants::DW_TAG_member);
        first.name = Some("x".into());
        first.type_ref = Some(1);
        dies.insert(2, first);
        let mut second = raw(constants::DW_TAG_member);
        second.name = Some("y".into());
        second.type_ref = Some(1);
        second.member_offset = 4;
        dies.insert(3, second);

        let mut pair = raw(constants::DW_TAG_structure_type);
        pair.name = Some("Pair".into());
        pair.byte_size = Some(8);
        pair.children = vec![2, 3];
        dies.insert(4, pair);

        let descriptor = descriptor_for_type(
            &dies,
            4,
            "position",
            "position",
            0x2000_0100,
            true,
            8,
            0,
            &mut HashSet::new(),
        );
        assert_eq!(descriptor.children.len(), 2);
        assert_eq!(descriptor.children[0].expression, "position.x");
        assert_eq!(descriptor.children[0].address, Some(0x2000_0100));
        assert_eq!(descriptor.children[0].scalar_kind, ScalarKind::Float32);
        assert_eq!(descriptor.children[1].expression, "position.y");
        assert_eq!(descriptor.children[1].address, Some(0x2000_0104));
    }
}
