require 'json'
require_relative 'NativeDependencyNotices'

HypergolicNativeDependencyNotices.verify(File.join(__dir__, 'Resources', 'notices'), File.expand_path('../../..', __dir__))

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

repo = File.expand_path('../../..', __dir__)
unless ['index.html', 'host.js', 'assets-manifest.json', 'fixture-release.json'].all? { |name| File.file?(File.join(__dir__, 'Resources', 'runtime', name)) }
  raise 'Failed to prepare the embedded runtime' unless system('node', File.join(repo, 'scripts/build-runtime.mjs'), chdir: repo)
end

Pod::Spec.new do |s|
  s.name = 'HypergolicNappletHost'
  s.version = package['version']
  s.summary = 'Restricted bundled napplet host for Hypergolic'
  s.description = 'A local Expo WKWebView host with native generation-bound diagnostics.'
  s.license = { :type => 'MIT' }
  s.author = 'Hypergolic contributors'
  s.homepage = 'https://github.com/nostrocket/hypergolic'
  s.source = { :git => 'https://github.com/nostrocket/hypergolic.git' }
  # Explicit integration candidate: public chooser cancellation requires 18.4.
  s.platforms = { :ios => '18.4' }
  s.swift_version = '6.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit', 'CryptoKit', 'Network', 'Security', 'AVFoundation'
  s.script_phase = {
    :name => 'Check reviewed Hypergolic runtime',
    :script => 'set -eu
cd "$PODS_TARGET_SRCROOT/../../.."
if [ -f ios/.xcode.env ]; then . ios/.xcode.env; fi
if [ -f ios/.xcode.env.local ]; then . ios/.xcode.env.local; fi
export PATH="$(dirname "${NODE_BINARY:-node}"):$PATH"
"${NODE_BINARY:-node}" scripts/build-runtime.mjs --check-ios',
    :execution_position => :before_compile
  }
  s.source_files = '**/*.swift'
  s.resource_bundles = { 'HypergolicNappletHostAssets' => ['Resources/runtime/*', 'Resources/notices/*', 'Resources/shell-notices/*'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
