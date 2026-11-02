require 'tmpdir'
require 'fileutils'
require 'json'
require 'digest'
root = File.expand_path('../../..', __dir__)
require File.join(root, 'plugins/native-codec-patches')
manifest = JSON.parse(File.binread(File.join(root, 'plugins/native-codec-patches.json')))
results = []
Dir.mktmpdir('hypergolic-native-codec-hook-') do |directory|
  manifest.fetch('files').each do |entry|
    file = File.join(directory, entry.fetch('path'))
    FileUtils.mkdir_p(File.dirname(file))
    original = File.binread(File.join(root, 'ios/Pods', entry.fetch('path')))
    entry.fetch('replacements').reverse_each { |change| original = original.sub(change.fetch('after'), change.fetch('before')) }
    raise 'Original source reconstruction differs' unless Digest::SHA256.hexdigest(original) == entry.fetch('beforeSha256')
    File.binwrite(file, original)
    File.chmod(0444, file)
  end
  first = File.join(directory, manifest.fetch('files')[0].fetch('path'))
  second = File.join(directory, manifest.fetch('files')[1].fetch('path'))
  first_before = File.binread(first)
  second_before = File.binread(second)
  File.chmod(0644, second)
  File.binwrite(second, second_before + "\n/* source drift */\n")
  begin
    HypergolicNativeCodecPatches.apply(directory)
    raise 'Source drift was admitted'
  rescue RuntimeError => error
    raise unless error.message.include?('Native codec source changed')
  end
  raise 'A staged source was written before validation finished' unless File.binread(first) == first_before
  results << 'second-file drift rejects before first-file mutation'
  File.binwrite(second, second_before)
  File.chmod(0444, second)
  HypergolicNativeCodecPatches.apply(directory)
  HypergolicNativeCodecPatches.apply(directory)
  manifest.fetch('files').each do |entry|
    file = File.join(directory, entry.fetch('path'))
    raise 'Patched source mismatch' unless Digest::SHA256.file(file).hexdigest == entry.fetch('afterSha256')
    raise 'Read-only file mode changed' unless File.stat(file).mode & 0777 == 0444
  end
  results << 'both known sources patched; repeated hook preserves bytes and read-only modes'
end
puts JSON.generate({ status: 'passed', cases: results, temporaryFixturesRemoved: true })
