import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, constants, verify } from 'node:crypto';
import { test } from 'node:test';
const root = createRequire(import.meta.url);
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const forge = cli('node-forge');
const certificates = cli('@expo/code-signing-certificates');

// Regression for GHSA-86w9-cpqp-85rv. Forge accepts optional absent parameters;
// OpenSSL requires SHA-256 NULL parameters and rejects all malformed encodings.
test('Expo tooling rejects malformed RSA DigestInfo encodings', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
  const secret = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const pub = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  const digest = forge.md.sha256.create().update('nested algorithm regression').digest().getBytes();
  const { asn1 } = forge;
  const make = (type, constructed, value) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  const oid = () => make(asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).getBytes());
  const nil = () => make(asn1.Type.NULL, false, '');
  const extra = () => make(asn1.Type.OCTETSTRING, false, 'unconsumed');
  const body = () => make(asn1.Type.OCTETSTRING, false, digest);
  const noncanonicalOid = (der) => {
    // Add a redundant base-128 zero to the SHA-256 OID and repair its three enclosing lengths.
    const encoded = Buffer.concat([der.subarray(0, 7), Buffer.from([0x80]), der.subarray(7)]);
    for (const offset of [1, 3, 5]) encoded[offset]++;
    return encoded;
  };
  let checked = 0;
  for (const [name, children, accepted, opensslAccepted, encode] of [
    ['normal NULL', [oid(), nil()], true, true],
    ['normal absent parameters', [oid()], true, false],
    ['extra after NULL', [oid(), nil(), extra()], false],
    ['extra without NULL', [oid(), extra()], false],
    ['extra NULL', [oid(), nil(), nil()], false],
    ['nonempty NULL', [oid(), make(asn1.Type.NULL, false, 'x')], false],
    ['nonminimal outer length', [oid(), nil()], false, false,
      (der) => Buffer.concat([der.subarray(0, 1), Buffer.from([0x81]), der.subarray(1)])],
    ['noncanonical OID', [oid(), nil()], false, false, noncanonicalOid],
    ['indefinite outer SEQUENCE', [oid(), nil()], false, false,
      (der) => Buffer.concat([Buffer.from([0x30, 0x80]), der.subarray(2), Buffer.from([0, 0])])],
  ]) {
    const der = asn1.toDer(make(asn1.Type.SEQUENCE, true, [make(asn1.Type.SEQUENCE, true, children), body()])).getBytes();
    const encoded = encode ? encode(Buffer.from(der, 'binary')).toString('binary') : der;
    const signature = secret.sign(encoded, 'NONE');
    let result = false;
    try { result = pub.verify(digest, signature); } catch (error) {
      assert.match(error.message, /valid RSASSA-PKCS1-v1_5 DigestInfo/);
    }
    const openssl = verify('RSA-SHA256', Buffer.from('nested algorithm regression'), {key: publicKey, padding: constants.RSA_PKCS1_PADDING}, Buffer.from(signature, 'binary'));
    assert.equal(openssl, opensslAccepted ?? false, `${name}: independent OpenSSL validation`);
    assert.equal(result, accepted, `${name}: Forge validation`);
    checked++;
  }
  assert.equal(checked, 9);
});

test('Expo certificate APIs retain valid generation, CSR and manifest signing', () => {
  const pair = certificates.generateKeyPair();
  const pem = certificates.convertKeyPairToPEM(pair);
  const imported = certificates.convertKeyPairPEMToKeyPair(pem);
  const now = Date.now();
  const cert = certificates.generateSelfSignedCodeSigningCertificate({
    keyPair: imported, commonName: 'Disposable tooling regression',
    validityNotBefore: new Date(now - 60_000), validityNotAfter: new Date(now + 60_000),
  });
  certificates.validateSelfSignedCertificate(cert, imported);
  const parsed = certificates.convertCertificatePEMToCertificate(
    certificates.convertCertificateToCertificatePEM(cert));
  const buffer = Buffer.from('test manifest');
  const signature = certificates.signBufferRSASHA256AndVerify(imported.privateKey, parsed, buffer);
  assert.equal(verify('RSA-SHA256', buffer, pem.publicKeyPEM, Buffer.from(signature, 'base64')), true);
  assert.equal(verify('RSA-SHA256', Buffer.from('altered manifest'), pem.publicKeyPEM, Buffer.from(signature, 'base64')), false);
  const csr = certificates.convertCSRPEMToCSR(certificates.convertCSRToCSRPEM(
    certificates.generateCSR(imported, 'Disposable development regression')));
  assert.equal(csr.verify(), true);
  const development = certificates.generateDevelopmentCertificateFromCSR(
    imported.privateKey, parsed, csr, 'fixture-project', 'fixture-scope');
  assert.equal(parsed.verify(development), true);
  assert.equal(development.getExtension({ id: certificates.expoProjectInformationOID }).value,
    'fixture-project,fixture-scope');
  const foreign = certificates.generateKeyPair();
  assert.throws(() => certificates.validateSelfSignedCertificate(parsed, foreign), /does not match/);
});

test('Forge PEM decoding retains Buffer input compatibility', () => {
  const pem = '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----\n';
  const decoded = forge.pem.decode(pem);
  assert.equal(decoded[0].body, '\x01\x02\x03');
  assert.deepEqual(forge.pem.decode(Buffer.from(pem)), decoded);
});

test('Expo CLI reads signing information from a disposable certificate', async () => {
  const pair = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60000);
  certificate.validity.notAfter = new Date(Date.now() + 60000);
  const fields = [
    { name: 'commonName', value: 'Disposable Expo parser fixture' },
    { name: 'organizationName', value: 'Disposable Team' },
    { name: 'organizationalUnitName', value: 'TESTTEAM01' },
  ];
  certificate.setSubject(fields);
  certificate.setIssuer(fields);
  certificate.sign(pair.privateKey, forge.md.sha256.create());
  let pem = forge.pki.certificateToPem(certificate);
  const filename = cli.resolve('./build/src/run/ios/codeSigning/Security.js');
  const source = readFileSync(filename, 'utf8');
  const actual = new Module(filename);
  actual.filename = filename;
  const actualRequire = createRequire(filename);
  let calls = 0;
  actual.require = function(request) {
    if (request === '@expo/spawn-async') return async (command, args) => {
      assert.equal(command, 'security');
      assert.deepEqual(args, ['find-certificate', '-c', 'DISPOSABLE', '-p']);
      calls++;
      return { stdout: pem };
    };
    return actualRequire(request);
  };
  actual._compile(source, filename);
  const parsed = await actual.exports.getCertificateForSigningIdAsync('DISPOSABLE');
  assert.equal(parsed.subject.getField('CN').value, fields[0].value);
  assert.deepEqual(await actual.exports.resolveCertificateSigningInfoAsync('DISPOSABLE'), {
    signingCertificateId: 'DISPOSABLE', codeSigningInfo: fields[0].value,
    appleTeamName: fields[1].value, appleTeamId: fields[2].value,
  });
  pem = 'invalid disposable certificate';
  await assert.rejects(actual.exports.getCertificateForSigningIdAsync('DISPOSABLE'));
  assert.equal(calls, 3);
});

// GHSA-6889-vf6x-f3g5: an identity public key must not authenticate arbitrary messages.
test('Expo tooling rejects Ed25519 signatures under a small-order public key', () => {
  const message = Buffer.from('disposable signature regression');
  const pair = forge.pki.ed25519.generateKeyPair();
  const signature = forge.pki.ed25519.sign({ message, privateKey: pair.privateKey });
  assert.equal(forge.pki.ed25519.verify({ message, signature, publicKey: pair.publicKey }), true);
  assert.equal(forge.pki.ed25519.verify({ message: Buffer.from('altered'), signature, publicKey: pair.publicKey }), false);
  const identity = Buffer.alloc(32);
  identity[0] = 1;
  const forged = Buffer.alloc(64);
  identity.copy(forged);
  for (const payload of [message, Buffer.from('unrelated message')]) {
    assert.equal(forge.pki.ed25519.verify({ message: payload, signature: forged, publicKey: identity }), false);
  }
});
