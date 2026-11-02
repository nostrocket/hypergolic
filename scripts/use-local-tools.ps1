$nodeDirectory = Join-Path $PSScriptRoot '../.tools/node-v24.20.0-win-x64'
if (!(Test-Path (Join-Path $nodeDirectory 'node.exe'))) {
    throw 'Install Node 24.20.0 or restore the project-local runtime; see docs/development.md.'
}
$env:PATH = "$nodeDirectory;$env:PATH"
$jdkDirectory = Join-Path $PSScriptRoot '../.tools/jdk17/jdk-17.0.20.1+1'
if (Test-Path $jdkDirectory) {
    $env:JAVA_HOME = (Resolve-Path $jdkDirectory).Path
    $env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
}
$sdkDirectory = Join-Path $PSScriptRoot '../.tools/android-sdk'
if (Test-Path $sdkDirectory) {
    $env:ANDROID_HOME = (Resolve-Path $sdkDirectory).Path
    $env:PATH = "$env:ANDROID_HOME/platform-tools;$env:PATH"
}
$env:EXPO_NO_TELEMETRY = '1'
$javaTempDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.tools/java-tmp'))
New-Item -ItemType Directory -Force $javaTempDirectory | Out-Null
$javaTempOption = "-Djdk.net.unixdomain.tmpdir=$javaTempDirectory"
if ($env:JAVA_TOOL_OPTIONS -notlike '*-Djdk.net.unixdomain.tmpdir=*') {
    $env:JAVA_TOOL_OPTIONS = "$env:JAVA_TOOL_OPTIONS $javaTempOption".Trim()
}
