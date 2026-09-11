use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use svd_parser::svd::{
    Access, ClusterInfo, FieldInfo, MaybeArray, PeripheralInfo, RegisterCluster, RegisterInfo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvdTree {
    pub device_name: String,
    pub peripherals: Vec<SvdPeripheral>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvdPeripheral {
    pub name: String,
    pub description: Option<String>,
    pub base_address: u64,
    pub registers: Vec<SvdRegister>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvdRegister {
    pub name: String,
    pub description: Option<String>,
    pub address: u64,
    pub size_bits: u32,
    pub access: Option<String>,
    pub reset_value: Option<u64>,
    pub fields: Vec<SvdField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvdField {
    pub name: String,
    pub description: Option<String>,
    pub bit_offset: u32,
    pub bit_width: u32,
    pub access: Option<String>,
}

pub fn load_svd(path: &Path) -> Result<SvdTree> {
    let xml = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read SVD {}", path.display()))?;
    parse_svd(&xml).with_context(|| format!("failed to parse SVD {}", path.display()))
}

pub fn parse_svd(xml: &str) -> Result<SvdTree> {
    let config = svd_parser::Config::default()
        .validate_level(svd_parser::ValidateLevel::Weak)
        .expand_properties(true)
        .expand(true);
    let device = svd_parser::parse_with_config(xml, &config)?;
    let mut peripherals = Vec::new();
    for peripheral in &device.peripherals {
        match peripheral {
            MaybeArray::Single(info) => peripherals.push(convert_peripheral(info)?),
            MaybeArray::Array(info, dim) => {
                for instance in svd_parser::svd::peripheral::expand(info, dim) {
                    peripherals.push(convert_peripheral(&instance)?);
                }
            }
        }
    }
    peripherals.sort_by_key(|item| item.base_address);
    Ok(SvdTree {
        device_name: device.name,
        peripherals,
    })
}

fn convert_peripheral(peripheral: &PeripheralInfo) -> Result<SvdPeripheral> {
    let mut registers = Vec::new();
    if let Some(children) = &peripheral.registers {
        collect_registers(children, peripheral.base_address, "", &mut registers)?;
    }
    registers.sort_by_key(|item| item.address);
    Ok(SvdPeripheral {
        name: peripheral.name.clone(),
        description: peripheral.description.clone(),
        base_address: peripheral.base_address,
        registers,
    })
}

fn collect_registers(
    children: &[RegisterCluster],
    base: u64,
    prefix: &str,
    output: &mut Vec<SvdRegister>,
) -> Result<()> {
    for child in children {
        match child {
            RegisterCluster::Register(register) => match register {
                MaybeArray::Single(info) => output.push(convert_register(info, base, prefix)?),
                MaybeArray::Array(info, dim) => {
                    for instance in svd_parser::svd::register::expand(info, dim) {
                        output.push(convert_register(&instance, base, prefix)?);
                    }
                }
            },
            RegisterCluster::Cluster(cluster) => match cluster {
                MaybeArray::Single(info) => collect_cluster(info, base, prefix, output)?,
                MaybeArray::Array(info, dim) => {
                    for instance in svd_parser::svd::cluster::expand(info, dim) {
                        collect_cluster(&instance, base, prefix, output)?;
                    }
                }
            },
        }
    }
    Ok(())
}

fn collect_cluster(
    cluster: &ClusterInfo,
    base: u64,
    prefix: &str,
    output: &mut Vec<SvdRegister>,
) -> Result<()> {
    let address = base
        .checked_add(u64::from(cluster.address_offset))
        .context("SVD cluster address overflow")?;
    collect_registers(
        &cluster.children,
        address,
        &format!("{prefix}{}.", cluster.name),
        output,
    )
}

fn convert_register(register: &RegisterInfo, base: u64, prefix: &str) -> Result<SvdRegister> {
    let address = base
        .checked_add(u64::from(register.address_offset))
        .context("SVD register address overflow")?;
    let mut fields = Vec::new();
    if let Some(source) = &register.fields {
        for field in source {
            match field {
                MaybeArray::Single(info) => {
                    fields.push(convert_field(info, register.properties.access))
                }
                MaybeArray::Array(info, dim) => fields.extend(
                    svd_parser::svd::field::expand(info, dim)
                        .map(|field| convert_field(&field, register.properties.access)),
                ),
            }
        }
    }
    fields.sort_by_key(|field| field.bit_offset);
    Ok(SvdRegister {
        name: format!("{prefix}{}", register.name),
        description: register.description.clone(),
        address,
        size_bits: register.properties.size.unwrap_or(32),
        access: access_label(register.properties.access),
        reset_value: register.properties.reset_value,
        fields,
    })
}

fn convert_field(field: &FieldInfo, inherited: Option<Access>) -> SvdField {
    SvdField {
        name: field.name.clone(),
        description: field.description.clone(),
        bit_offset: field.bit_offset(),
        bit_width: field.bit_width(),
        access: access_label(field.access.or(inherited)),
    }
}

fn access_label(access: Option<Access>) -> Option<String> {
    access.map(|access| format!("{access:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_device() {
        let xml = r#"<device schemaVersion="1.3"><name>Demo</name><version>1</version><description>Demo</description><addressUnitBits>8</addressUnitBits><width>32</width><peripherals><peripheral><name>GPIO</name><description>GPIO</description><baseAddress>0x40000000</baseAddress><registers><register><name>ODR</name><description>Output</description><addressOffset>0x14</addressOffset><size>32</size><fields><field><name>PIN0</name><description>pin</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields></register></registers></peripheral></peripherals></device>"#;
        let tree = parse_svd(xml).unwrap();
        assert_eq!(tree.device_name, "Demo");
        assert_eq!(tree.peripherals[0].registers[0].address, 0x4000_0014);
    }
}
