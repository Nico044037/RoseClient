# Windows PowerShell can treat java -version's stderr output as a terminating
# error when $ErrorActionPreference is Stop, even though Java exited successfully.
# Oracle Java prints its version to stderr, so capture both streams without throwing.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

try {
    $lines = @(& java -version 2>&1 | ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
    $output = $lines -join [Environment]::NewLine

    $match = [regex]::Match($output, '(?i)\bversion\s+["'']?(\d+)')
    if (-not $match.Success) {
        $match = [regex]::Match($output, '(?i)\bopenjdk\s+(\d+)')
    }
    if (-not $match.Success) {
        Write-Host 'Could not parse Java version output:'
        Write-Host $output
        exit 1
    }

    $major = [int]$match.Groups[1].Value
    Write-Host "Detected Java major version: $major"
    if ($exitCode -ne 0) {
        Write-Host "Java returned exit code $exitCode."
        Write-Host $output
        exit 1
    }
    if ($major -lt 25) {
        Write-Host 'Java 25 or newer is required for Minecraft 26.1.2.'
        Write-Host $output
        exit 1
    }

    Write-Host 'Java version check passed.'
    exit 0
} catch {
    Write-Host "Java version check failed: $($_.Exception.Message)"
    exit 1
}
