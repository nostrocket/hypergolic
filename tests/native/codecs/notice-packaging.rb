require 'tmpdir'
require 'fileutils'
root = File.expand_path('../../..', __dir__)
require File.join(root, 'modules/napplet-host/ios/NativeDependencyNotices')
source = File.join(root, 'modules/napplet-host/ios/Resources/notices')
HypergolicNativeDependencyNotices.verify(source, root)
cases = ['current original notices pass']
Dir.mktmpdir('hypergolic-native-notices-') do |directory|
  FileUtils.cp_r(File.join(source, '.'), directory)
  file = File.join(directory, 'libdav1d-COPYING.txt')
  original = File.binread(file)
  File.binwrite(file, original.sub('VideoLAN', 'Changed!'))
  begin
    HypergolicNativeDependencyNotices.verify(directory)
    raise 'Changed attribution was admitted'
  rescue RuntimeError => error
    raise unless error.message.include?('Native notice bytes changed')
  end
  cases << 'same-length attribution change rejects'
  File.binwrite(file, original)
  File.delete(File.join(directory, 'libdav1d-PATENTS.txt'))
  begin
    HypergolicNativeDependencyNotices.verify(directory)
    raise 'Missing patent notice was admitted'
  rescue RuntimeError => error
    raise unless error.message.include?('Native notice files changed')
  end
  cases << 'missing patent original rejects'
  FileUtils.cp(File.join(source, 'libdav1d-PATENTS.txt'), directory)
  # Keep dependency fixtures outside the resource directory's complete file set.
  Dir.mktmpdir('hypergolic-notice-dependencies-') do |fixture|
    inputs = JSON.parse(File.binread(File.join(directory, 'manifest.json'))).fetch('mainJavaScriptProfile').fetch('dependencyInputs')
    native_inputs = JSON.parse(File.binread(File.join(directory, 'manifest.json'))).fetch('nativeSourceProfile').fetch('sources').flat_map { |source| [source.fetch('path'), source.fetch('vendorPath')] }
    (inputs.keys + native_inputs).uniq.each do |name|
      target = File.join(fixture, name)
      FileUtils.mkdir_p(File.dirname(target))
      FileUtils.cp(File.join(root, name), target)
    end
    HypergolicNativeDependencyNotices.verify(directory, fixture)
    File.open(File.join(fixture, 'package.json'), 'a') { |file| file.write("\n") }
    begin
      HypergolicNativeDependencyNotices.verify(directory, fixture)
      raise 'Stale dependency metadata was admitted'
    rescue RuntimeError => error
      raise unless error.message.include?('Native notice dependency inputs changed')
    end
    cases << 'changed dependency metadata rejects stale notice profile'
    FileUtils.cp(File.join(root, 'package.json'), File.join(fixture, 'package.json'))
    manifest_file = File.join(directory, 'manifest.json')
    before = File.binread(manifest_file)
    {
      'unsafe SQLite source path rejects' => ['Native SQLite source set changed', ->(profile) { profile.fetch('sources')[0]['path'] = '../outside' }],
      'altered SQLite reconstruction rejects' => ['Native SQLite source provenance changed', ->(profile) { profile.fetch('sources')[0]['upstreamSha256'] = '0' * 64 }],
      'moved SQLite original range rejects' => ['Native SQLite original range changed', ->(profile) { profile.fetch('sources')[0]['byteStart'] += 1 }],
      'changed SQLite wrapper original rejects' => ['Native SQLite wrapper original changed', ->(profile) { profile.fetch('wrapperOriginal')['sha256'] = '0' * 64 }]
    }.each do |label, (expected_error, edit)|
      changed = JSON.parse(before); edit.call(changed.fetch('nativeSourceProfile'))
      File.binwrite(manifest_file, JSON.generate(changed))
      begin
        HypergolicNativeDependencyNotices.verify(directory, fixture)
        raise 'Changed SQLite attribution was admitted'
      rescue RuntimeError => error
        raise unless error.message.include?(expected_error)
      end
      cases << label
      File.binwrite(manifest_file, before)
    end

  end
end
puts JSON.generate({ status: 'passed', cases: cases, temporaryFixturesRemoved: true })
