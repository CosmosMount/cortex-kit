use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use gimli::{Dwarf, EndianSlice, Reader, RunTimeEndian, SectionId, Unit};
use object::{Object, ObjectSection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableLine {
    pub path: String,
    pub line: u64,
    pub address: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIndex {
    pub files: Vec<String>,
    pub executable_lines: Vec<ExecutableLine>,
}

pub fn load_source_index(path: &Path) -> Result<SourceIndex> {
    let data =
        std::fs::read(path).with_context(|| format!("failed to read ELF {}", path.display()))?;
    let object = object::read::File::parse(data.as_slice()).context("failed to parse ELF")?;
    let endian = match object.endianness() {
        object::Endianness::Little => RunTimeEndian::Little,
        object::Endianness::Big => RunTimeEndian::Big,
    };
    let dwarf = load_dwarf(&object, endian)?;
    let mut paths = BTreeSet::new();
    let mut executable_lines = BTreeMap::new();
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let compilation_dir = unit.comp_dir.as_ref().and_then(reader_string);
        if let Some(program) = unit.line_program.as_ref() {
            let mut rows = program.clone().rows();
            while let Some((header, row)) = rows.next_row()? {
                if row.end_sequence() || !row.is_stmt() {
                    continue;
                }
                let Some(line) = row.line().map(std::num::NonZeroU64::get) else {
                    continue;
                };
                let Some(path) = source_path(
                    &dwarf,
                    &unit,
                    header,
                    row.file_index(),
                    compilation_dir.as_deref(),
                ) else {
                    continue;
                };
                paths.insert(path.clone());
                executable_lines
                    .entry((path, line))
                    .and_modify(|address: &mut u64| *address = (*address).min(row.address()))
                    .or_insert(row.address());
            }
        }
    }
    Ok(SourceIndex {
        files: paths.into_iter().collect(),
        executable_lines: executable_lines
            .into_iter()
            .map(|((path, line), address)| ExecutableLine {
                path,
                line,
                address,
            })
            .collect(),
    })
}

pub fn resolve_source_line(
    index: &SourceIndex,
    requested_path: &str,
    requested_line: u64,
) -> Option<ExecutableLine> {
    let requested = normalize_path(requested_path);
    let basename = requested.rsplit('/').next()?;
    let mut candidates = index
        .files
        .iter()
        .filter(|path| {
            let normalized = normalize_path(path);
            normalized == requested || normalized.ends_with(&format!("/{requested}"))
        })
        .cloned()
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        candidates = index
            .files
            .iter()
            .filter(|path| normalize_path(path).rsplit('/').next() == Some(basename))
            .cloned()
            .collect();
    }
    if candidates.len() != 1 {
        return None;
    }
    let selected = normalize_path(&candidates[0]);
    index
        .executable_lines
        .iter()
        .filter(|row| {
            normalize_path(&row.path) == selected
                && row.line >= requested_line
                && row.line <= requested_line.saturating_add(32)
        })
        .min_by_key(|row| (row.line, row.address))
        .cloned()
}

/// Maps a halted program counter to the closest executable source row at or
/// before that address. An exact match is expected for a hardware breakpoint;
/// the preceding-row fallback also covers instructions within the same row.
pub fn resolve_instruction(index: &SourceIndex, address: u64) -> Option<ExecutableLine> {
    index
        .executable_lines
        .iter()
        .filter(|row| row.address <= address)
        .max_by_key(|row| row.address)
        .cloned()
}

pub(crate) fn load_dwarf<'a>(
    object: &'a object::read::File<'a>,
    endian: RunTimeEndian,
) -> Result<Dwarf<EndianSlice<'a, RunTimeEndian>>> {
    let dwarf = Dwarf::load(|id: SectionId| -> Result<EndianSlice<'a, RunTimeEndian>> {
        let data = match object.section_by_name(id.name()) {
            Some(section) => section
                .data()
                .with_context(|| format!("failed to read {}", id.name()))?,
            None => &[],
        };
        Ok(EndianSlice::new(data, endian))
    })?;
    if ![SectionId::DebugInfo, SectionId::DebugLine]
        .iter()
        .any(|id| object.section_by_name(id.name()).is_some())
    {
        bail!("ELF has no DWARF sections");
    }
    Ok(dwarf)
}

fn source_path<'a>(
    dwarf: &Dwarf<EndianSlice<'a, RunTimeEndian>>,
    unit: &Unit<EndianSlice<'a, RunTimeEndian>>,
    header: &gimli::LineProgramHeader<EndianSlice<'a, RunTimeEndian>>,
    file_index: u64,
    compilation_dir: Option<&str>,
) -> Option<String> {
    let file = header.file(file_index)?;
    let name = dwarf
        .attr_string(unit, file.path_name())
        .ok()
        .and_then(|reader| reader_string(&reader))?;
    let directory = file
        .directory(header)
        .and_then(|value| dwarf.attr_string(unit, value).ok())
        .and_then(|reader| reader_string(&reader));
    let mut source = directory.map(PathBuf::from).unwrap_or_default().join(name);
    if source.is_relative() {
        if let Some(directory) = compilation_dir {
            source = Path::new(directory).join(source);
        }
    }
    Some(source.to_string_lossy().into_owned())
}

fn reader_string<R: Reader>(reader: &R) -> Option<String> {
    reader
        .to_slice()
        .ok()
        .map(|bytes| String::from_utf8_lossy(bytes.as_ref()).into_owned())
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .fold(Vec::new(), |mut parts, part| {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                value => parts.push(value),
            }
            parts
        })
        .join("/")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_unique_suffix_and_next_statement() {
        let index = SourceIndex {
            files: vec!["/build/app/src/main.c".into()],
            executable_lines: vec![
                ExecutableLine {
                    path: "/build/app/src/main.c".into(),
                    line: 12,
                    address: 0x100,
                },
                ExecutableLine {
                    path: "/build/app/src/main.c".into(),
                    line: 16,
                    address: 0x140,
                },
            ],
        };
        assert_eq!(
            resolve_source_line(&index, "src/main.c", 13)
                .unwrap()
                .address,
            0x140
        );
    }

    #[test]
    fn resolves_program_counter_to_preceding_row() {
        let index = SourceIndex {
            files: vec!["/build/app/src/main.c".into()],
            executable_lines: vec![
                ExecutableLine {
                    path: "/build/app/src/main.c".into(),
                    line: 20,
                    address: 0x100,
                },
                ExecutableLine {
                    path: "/build/app/src/main.c".into(),
                    line: 21,
                    address: 0x108,
                },
            ],
        };
        let row = resolve_instruction(&index, 0x10a).unwrap();
        assert_eq!(row.line, 21);
        assert_eq!(row.address, 0x108);
    }
}
