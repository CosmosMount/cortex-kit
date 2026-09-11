param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CargoArguments
)

$systemCargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($systemCargo) {
    & $systemCargo.Source @CargoArguments
    exit $LASTEXITCODE
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localCargo = Join-Path $repositoryRoot '.tooling\cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $localCargo)) {
    Write-Error 'Cargo was not found. Install Rust or create the optional .tooling workspace toolchain.'
    exit 1
}

$env:RUSTUP_HOME = Join-Path $repositoryRoot '.tooling\rustup'
$env:CARGO_HOME = Join-Path $repositoryRoot '.tooling\cargo'
& $localCargo '+stable-x86_64-pc-windows-gnu' @CargoArguments
exit $LASTEXITCODE
