require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'HypergolicIdentityOwner'
  s.version = package['version']
  s.summary = 'Process-lifetime trusted identity bootstrap admission'
  s.description = 'One synchronous process-static claim; no reset, storage or authorization API.'
  s.license = { :type => 'MIT' }
  s.author = 'Hypergolic contributors'
  s.homepage = 'https://github.com/nostrocket/hypergolic'
  s.source = { :git => 'https://github.com/nostrocket/hypergolic.git' }
  s.platforms = { :ios => '18.4' }
  s.swift_version = '6.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
