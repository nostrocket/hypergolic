require 'json'
require_relative 'NativeDependencyNotices'

HypergolicNativeDependencyNotices.verify(File.join(__dir__, 'Resources', 'notices'), File.expand_path('../../..', __dir__))

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

['index.html', 'host.js', 'assets-manifest.json'].each do |name|
  raise 'Run pnpm runtime:build before pod installation: missing iOS runtime assets' unless File.file?(File.join(__dir__, 'Resources', 'runtime', name))
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
  s.frameworks = 'WebKit', 'CryptoKit', 'Network', 'Security'
  s.source_files = '**/*.swift'
  s.resource_bundles = { 'HypergolicNappletHostAssets' => ['Resources/runtime/*', 'Resources/notices/*', 'Resources/shell-notices/*'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
