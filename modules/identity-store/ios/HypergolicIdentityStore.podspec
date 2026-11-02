require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'HypergolicIdentityStore'
  s.version = package['version']
  s.summary = 'Native encrypted identity storage for Hypergolic'
  s.description = 'Keychain-wrapped, backup-excluded iOS identity secret files.'
  s.license = { :type => 'MIT' }
  s.author = 'Hypergolic contributors'
  s.homepage = 'https://github.com/nostrocket/hypergolic'
  s.source = { :git => 'https://github.com/nostrocket/hypergolic.git' }
  s.platforms = { :ios => '18.4' }
  s.swift_version = '6.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'HypergolicIdentityOwner'
  s.frameworks = 'Security', 'CryptoKit', 'LocalAuthentication', 'UIKit'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
