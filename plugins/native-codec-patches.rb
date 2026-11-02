require 'digest'
require 'json'

module HypergolicNativeCodecPatches
  def self.apply(sandbox)
    manifest = JSON.parse(File.binread(File.join(__dir__, 'native-codec-patches.json')))
    staged = manifest.fetch('files').map do |entry|
      file = File.join(sandbox, entry.fetch('path'))
      original = File.binread(file)
      digest = Digest::SHA256.hexdigest(original)
      next [file, original] if digest == entry.fetch('afterSha256')
      raise "Native codec source changed; review #{entry.fetch('path')}" unless digest == entry.fetch('beforeSha256')
      patched = original.dup
      entry.fetch('replacements').each do |change|
        before = change.fetch('before')
        raise 'Native codec patch context changed' unless patched.scan(before).length == 1
        patched = patched.sub(before, change.fetch('after'))
      end
      raise 'Native codec patched hash mismatch' unless Digest::SHA256.hexdigest(patched) == entry.fetch('afterSha256')
      [file, patched]
    end
    # Validate every source before writing; repeated pod installation is idempotent.
    staged.each do |file, contents|
      next if File.binread(file) == contents
      mode = File.stat(file).mode
      begin
        File.chmod(mode | 0200, file)
        File.binwrite(file, contents)
      ensure
        File.chmod(mode, file)
      end
    end
  end
end
