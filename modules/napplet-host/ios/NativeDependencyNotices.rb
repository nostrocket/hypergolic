require 'json'
require 'digest'

module HypergolicNativeDependencyNotices
  def self.verify(directory, project_root = nil)
    manifest = JSON.parse(File.binread(File.join(directory, 'manifest.json')))
    raise 'Unexpected native notice manifest' unless manifest.fetch('schemaVersion') == 1 && manifest.fetch('platform') == 'ios'
    notices = manifest.fetch('components').flat_map { |component| component.fetch('notices') }
    names = notices.map { |notice| notice.fetch('file') }
    raise 'Duplicate or unsafe native notice filename' unless names.uniq == names && names.all? { |name| File.basename(name) == name && name.end_with?('.txt') }
    raise 'Native notice files changed' unless Dir.children(directory).sort == (names + ['manifest.json']).sort
    manifest.fetch('components').each do |component|
      component.fetch('licenseNoticeFiles', []).each do |name|
        raise 'Shared native notice missing' unless names.include?(name)
      end
    end
    if project_root && manifest.key?('mainJavaScriptProfile')
      manifest.fetch('mainJavaScriptProfile').fetch('dependencyInputs').each do |name, expected|
        raise 'Unsafe native notice dependency input' if name.start_with?('/') || name.split('/').include?('..')
        file = File.join(project_root, name)
        raise "Native notice dependency inputs changed: #{name}" unless File.file?(file) && Digest::SHA256.file(file).hexdigest == expected
      end
    end
    if project_root && manifest.key?('nativeSourceProfile')
      profile = manifest.fetch('nativeSourceProfile')
      sources = profile.fetch('sources')
      expected = ['node_modules/expo-sqlite/ios/sqlite3.c', 'node_modules/expo-sqlite/ios/sqlite3.h']
      raise 'Native SQLite source set changed' unless sources.map { |source| source.fetch('path') }.sort == expected
      wrapper = profile.fetch('wrapperOriginal')
      raise 'Native SQLite wrapper original changed' unless names.include?(wrapper.fetch('file')) &&
        Digest::SHA256.file(File.join(directory, wrapper.fetch('file'))).hexdigest == wrapper.fetch('sha256')
      sources.each do |source|
        name = source.fetch('path')
        vendor = name.sub('/ios/', '/vendor/sqlite3/')
        raise 'Native SQLite vendor source path changed' unless source.fetch('vendorPath') == vendor
        bytes = File.binread(File.join(project_root, name))
        raise 'Native SQLite source provenance changed' unless bytes == File.binread(File.join(project_root, vendor)) &&
          Digest::SHA256.hexdigest(bytes) == source.fetch('sha256') &&
          bytes.scan('exsqlite3').length == source.fetch('prefixReplacementCount') &&
          Digest::SHA256.hexdigest(bytes.gsub('exsqlite3', 'sqlite3')) == source.fetch('upstreamSha256') &&
          bytes.include?('#define SQLITE_VERSION        "' + profile.fetch('version') + '"') &&
          bytes.include?('#define SQLITE_SOURCE_ID      "' + profile.fetch('sourceId') + '"')
        first = source.fetch('byteStart'); last = source.fetch('byteEndExclusive'); original = source.fetch('original')
        raise 'Native SQLite original range changed' unless names.include?(original.fetch('file')) &&
          first.is_a?(Integer) && last.is_a?(Integer) && first >= 0 && first < last && last <= bytes.bytesize &&
          bytes.byteslice(first, last - first) == File.binread(File.join(directory, original.fetch('file'))) &&
          Digest::SHA256.hexdigest(bytes.byteslice(first, last - first)) == original.fetch('sha256')
      end
    end
    notices.each do |notice|
      bytes = File.binread(File.join(directory, notice.fetch('file')))
      raise "Native notice bytes changed: #{notice.fetch('file')}" unless bytes.bytesize == notice.fetch('bytes') && Digest::SHA256.hexdigest(bytes) == notice.fetch('sha256')
    end
  end
end
