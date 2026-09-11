# Cortex Kit

Cortex Kit is a VS Code extension for Cortex-M debugging, live variable inspection, peripheral registers, multi-chart plotting, FFT analysis, and firmware flashing. A Rust debug adapter talks directly to ST-Link and CMSIS-DAP/DAPLink through [`probe-rs`](https://probe.rs/). OpenOCD and GDB are not runtime dependencies.

The current release is a Windows x64 prototype. ST-Link has been tested on an STM32H723VGT6 running an existing application. CMSIS-DAP/DAPLink uses the same `probe-rs` backend but still needs broader physical-probe coverage.

## Features

- Standard VS Code debug sessions with launch, attach, pause, continue, reset, instruction/source breakpoints, hardware stepping, CPU registers, memory access, and source navigation.
- Global and static variables indexed from ELF/AXF DWARF before a debug session starts.
- Native **Cortex Kit Variables**, **Live Watch**, **Peripherals**, and **Session** views.
- Typed Live Watch edits with automatic pause, write, probe flush, hardware readback, and automatic resume.
- Structure and array selection: selecting a container recursively adds its addressable scalar leaves; selecting individual fields remains supported.
- Multiple time-domain and FFT charts, shared variables, expressions, linked cursor, persistent layouts, drag-to-reorder, and auto-grid, side-by-side, or stacked arrangement.
- A binary loopback sample channel separated from DAP control traffic.
- Deduplicated block reads when the same variable appears in several charts or Live Watch.
- CMSIS-SVD peripheral, register, and bit-field inspection.
- ELF/AXF/OUT, Intel HEX, BIN, and UF2 flashing.
- Probe, `probe-rs` target, firmware image, SVD, build-task, and Arm GNU toolchain discovery.
- A deterministic Mock Probe for development without hardware.

Real DWARF stack unwinding and frame locals, source-aware step-over/step-out, real disassembly, complete CMSIS-Pack discovery, and physical DAPLink validation are still in progress. See [Implementation status](docs/IMPLEMENTATION_STATUS.md) for the exact boundary.

## How it is organized

```text
cortex-kit/
├── crates/
│   ├── cortex-kit-core/   # ELF/DWARF, SVD, expressions, FFT, protocol models
│   ├── cortex-kit-probe/  # single-owner ProbeWorker and probe-rs backend
│   └── cortex-kit-dap/    # DAP stdio server and binary sample service
├── extension/             # VS Code TypeScript extension
├── webview-ui/            # themed Plot panel
├── tests/                 # Mock and physical-hardware smoke tests
└── docs/
```

All probe access is serialized through one Worker. Adding or removing an active variable subscription briefly pauses a running target, updates the subscription, and resumes it. Layout-only changes do not touch the target. See [Architecture](docs/ARCHITECTURE.md) for protocol and state details.

## Install a packaged build

Download or build `cortex-kit-win32-x64.vsix`, then either use **Extensions: Install from VSIX...** in VS Code or run:

```powershell
code --install-extension .\cortex-kit-win32-x64.vsix
```

Reload the VS Code window after replacing an already-running development build.

## Configure a firmware workspace

An existing ELF or AXF with DWARF information is enough for variable discovery and debugging. Cortex Kit does not build or modify target firmware and does not require the Arm GNU toolchain when the image already exists.

Run **Cortex Kit: Configure Project**, or add configurations such as:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Cortex Kit: Live Plot (Attach)",
      "type": "cortex-kit",
      "request": "attach",
      "cwd": "${workspaceFolder}",
      "chip": "STM32H723VG",
      "programBinary": "${workspaceFolder}/build/Debug/firmware.elf",
      "plotOnly": true,
      "stopOnEntry": false,
      "probe": {
        "selector": "auto",
        "protocol": "swd",
        "speedKHz": 10000,
        "connectUnderReset": false
      },
      "flashing": {
        "enabled": false,
        "verify": false,
        "resetAfter": false
      },
      "acquisition": {
        "requestedSamplesPerSecond": 1000,
        "maxBurstMs": 2,
        "historySeconds": 30
      },
      "svdFile": "${workspaceFolder}/STM32H723.svd"
    },
    {
      "name": "Cortex Kit: Flash & Debug",
      "type": "cortex-kit",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "chip": "STM32H723VG",
      "programBinary": "${workspaceFolder}/build/Debug/firmware.elf",
      "probe": {
        "selector": "auto",
        "protocol": "swd",
        "speedKHz": 10000
      },
      "flashing": {
        "enabled": true,
        "verify": true,
        "resetAfter": true
      },
      "acquisition": {
        "requestedSamplesPerSecond": 5000,
        "maxBurstMs": 2,
        "historySeconds": 30
      },
      "svdFile": "${workspaceFolder}/STM32H723.svd"
    }
  ]
}
```

Use the exact target name shown by the `probe-rs` registry. For STM32H723VGT6, the tested registry entry is `STM32H723VG`. Set `probe.selector` to a selector reported by the configuration wizard when more than one probe is connected.

Assembly (`.s`) and linker-script (`.ld`) files do not contain the peripheral register description. Set `svdFile` to a CMSIS-SVD `.svd` file or run **Cortex Kit: Select SVD File**.

## Use Live Watch and Plot

1. Open **Run and Debug**. Cortex Kit indexes globals, structures, arrays, and fields from the configured ELF before the probe is connected.
2. Use **Cortex Kit: Add Live Watch Variable** or the eye action beside a Variables node. Selecting a structure or array adds every supported scalar descendant.
3. Start **Live Plot (Attach)** to inspect a running application without flashing, or **Flash & Debug** to build through an existing `preLaunchTask`, flash, verify, reset, and debug.
4. Use the pencil action on a writable Live Watch item. Cortex Kit automatically pauses, performs a typed write and hardware readback, then restores the previous running state.
5. Open the bottom **Cortex Kit** panel. Each chart has **+ Variable**, time/FFT mode, and a drag handle. Choose **Auto grid**, **Side by side**, or **Stacked** in the Plot header.

Plot-only mode allows explicit pause/continue and typed Live Watch writes. It rejects flashing, reset, stepping, arbitrary memory writes, and breakpoint installation.

## Develop and test

Required development tools:

- VS Code 1.96 or newer.
- Node.js and npm.
- Rust 1.85 or newer. `scripts/cargo.ps1` also understands the optional workspace-local `.tooling` installation used by this repository.

From PowerShell:

```powershell
cd D:\Workspace\projects\cortex-kit
.\scripts\cargo.ps1 test --workspace
.\scripts\cargo.ps1 build --workspace

cd extension
npm ci
npm test
npm run test:dap
```

Open the repository in VS Code and press `F5` to start the Extension Development Host. Select **Cortex Kit: Mock Debug** for the no-hardware path. Detailed Mock and STM32H723 procedures are in [VS Code and hardware testing](docs/TESTING.md).

## Package a VSIX

The package contains a native Rust executable, so the current artifact is platform-specific:

```powershell
cd D:\Workspace\projects\cortex-kit\extension
npm ci
npm test
npm run package
```

This builds the release Rust adapter, copies the Webview and this README into the extension, and creates:

```text
D:\Workspace\projects\cortex-kit\cortex-kit-win32-x64.vsix
```

Inspect the package before distribution:

```powershell
npx vsce ls --tree
code --install-extension ..\cortex-kit-win32-x64.vsix --force
```

Linux, macOS, Windows Arm64, and other targets need separate native backend builds and separate `vsce --target` packages. A Windows-built VSIX must not be published as a cross-platform fallback.

## Publish to the VS Code Marketplace

Before the first public upload:

1. Create a publisher in the [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage).
2. Replace the placeholder `publisher` value in `extension/package.json` with the exact publisher ID you own. Confirm that `name` and `displayName` are available and add final icon, license, support, and changelog metadata as appropriate.
3. Increment `version` for every new Marketplace build. A deleted version number cannot be reused.
4. Run the complete test and package commands above.

For a manual first upload, select the publisher in the management page, choose **New extension > Visual Studio Code**, and upload `cortex-kit-win32-x64.vsix`.

For CLI publishing, create an Azure DevOps Personal Access Token with the **Marketplace > Manage** scope, then run:

```powershell
cd D:\Workspace\projects\cortex-kit\extension
npx vsce login <publisher-id>
npx vsce publish --packagePath ..\cortex-kit-win32-x64.vsix
```

Do not place the token in this repository or a command-line argument. For CI, use Microsoft Entra ID workload identity with `vsce publish --azure-credential`; Microsoft has announced retirement of global Azure DevOps PATs on December 1, 2026.

The authoritative publication procedure is the [VS Code Publishing Extensions guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
