import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, constants, verify } from 'node:crypto';
import { test } from 'node:test';
const root = createRequire(import.meta.url);
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const forge = cli('node-forge');
const certificates = cli('@expo/code-signing-certificates');

// Regression for GHSA-86w9-cpqp-85rv. Forge accepts optional absent parameters;
// OpenSSL requires SHA-256 NULL parameters, and rejects all added children.
test('Expo tooling rejects extra nested RSA DigestAlgorithm children', () => {
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
  let checked = 0;
  for (const [name, children, accepted, opensslAccepted] of [
    ['normal NULL', [oid(), nil()], true, true],
    ['normal absent parameters', [oid()], true, false],
    ['extra after NULL', [oid(), nil(), extra()], false],
    ['extra without NULL', [oid(), extra()], false],
    ['extra NULL', [oid(), nil(), nil()], false],
  ]) {
    const der = asn1.toDer(make(asn1.Type.SEQUENCE, true, [make(asn1.Type.SEQUENCE, true, children), body()])).getBytes();
    const signature = secret.sign(der, 'NONE');
    let result = false;
    try { result = pub.verify(digest, signature); } catch (error) {
      assert.match(error.message, /valid RSASSA-PKCS1-v1_5 DigestInfo/);
    }
    const openssl = verify('RSA-SHA256', Buffer.from('nested algorithm regression'), {key: publicKey, padding: constants.RSA_PKCS1_PADDING}, Buffer.from(signature, 'binary'));
    assert.equal(openssl, opensslAccepted ?? false, `${name}: independent OpenSSL validation`);
    assert.equal(result, accepted, `${name}: Forge validation`);
    checked++;
  }
  assert.equal(checked, 5);
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
