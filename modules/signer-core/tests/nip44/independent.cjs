const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const path = require('node:path');
const applicationRoot = process.env.HYPERGOLIC_NIP44_APPLICATION_ROOT;
assert.ok(applicationRoot, 'Set HYPERGOLIC_NIP44_APPLICATION_ROOT to the application checkout');
const toolsPath = require.resolve('nostr-tools/nip44', {paths: [applicationRoot]});
const req = createRequire(fs.realpathSync(toolsPath));
const nip44 = req(toolsPath);
const {expand} = req('@noble/hashes/hkdf.js');
const {hmac} = req('@noble/hashes/hmac.js');
const {sha256} = req('@noble/hashes/sha2.js');
const {chacha20} = req('@noble/ciphers/chacha.js');
const conv = Buffer.from('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d','hex');
const nonce = Buffer.alloc(32); nonce[31] = 1;
const keys = expand(sha256, conv, nonce, 76);
function authenticated(padded) {
 const ciphertext = chacha20(keys.subarray(0,32), keys.subarray(32,44), padded);
 const mac = hmac(sha256,keys.subarray(44),Buffer.concat([nonce,ciphertext]));
 return Buffer.concat([Buffer.from([2]),nonce,ciphertext,mac]).toString('base64');
}
const mutations = [];
for (const mode of ['nonzero-padding','invalid-utf8','extended-prefix-below-threshold','extended-length-beyond-ciphertext']) {
 const padded=Buffer.alloc(34);padded[1]=1;padded[2]=97;
 if(mode==='nonzero-padding')padded[33]=1;
 if(mode==='invalid-utf8')padded[2]=128;
 if(mode==='extended-prefix-below-threshold'){padded.fill(0);padded[5]=1;padded[6]=97;}
 if(mode==='extended-length-beyond-ciphertext'){padded.fill(0);padded[3]=1;padded[6]=97;}
 mutations.push({name:mode,conversation_key:conv.toString('hex'),payload:authenticated(padded)});
}
const outputDirectory=process.env.HYPERGOLIC_NIP44_OUTPUT_DIR;
assert.ok(outputDirectory, 'Set HYPERGOLIC_NIP44_OUTPUT_DIR to the temporary proof directory');
fs.writeFileSync(path.join(outputDirectory,'authenticated-invalid.json'),JSON.stringify(mutations,null,2)+'\n');
if(process.argv.includes('--verify')) {
 for(const length of [65535,65536,65537,4202496]) {
  const actual=fs.readFileSync(path.join(outputDirectory,`interop-${length}.b64`),'ascii');
  const plaintext='a'.repeat(length);
  assert.equal(actual,nip44.encrypt(plaintext,conv,nonce));
  assert.equal(nip44.decrypt(actual,conv),plaintext);
 }
 console.log('Independent nostr-tools NIP44 interop: 65535/65536/65537/4202496 exact bytes and plaintext passed');
}
