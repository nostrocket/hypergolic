from pathlib import Path
import json,hashlib,argparse
root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
v=json.loads((root/'nip44.vectors.json').read_text())['v2']
assert hashlib.sha256((root/'nip44.vectors.json').read_bytes()).hexdigest()=='269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040'
q=json.dumps
lines=['static void official_vectors(void) {']
for row in v['valid']['get_conversation_key']:lines.append(' check_conversation('+','.join(q(row[k]) for k in ['sec1','pub2','conversation_key'])+');')
for row in v['invalid']['get_conversation_key']:lines.append(' check_invalid_conversation('+q(row['sec1'])+','+q(row['pub2'])+');')
keys=v['valid']['get_message_keys']
for row in keys['keys']:lines.append(' check_keys('+q(keys['conversation_key'])+','+q(row['nonce'])+','+q(row['chacha_key']+row['chacha_nonce']+row['hmac_key'])+');')
for length,expected in v['valid']['calc_padded_len']:lines.append(' CHECK(nip44_test_padded_length('+str(length)+') == '+str(expected)+');')
for row in v['valid']['encrypt_decrypt']:lines.append(' check_roundtrip('+','.join(q(row[k]) for k in ['sec1','sec2','nonce'])+','+q(row['plaintext'].encode().hex())+','+q(row['payload'])+');')
for row in v['invalid']['decrypt']:lines.append(' check_invalid_payload('+q(row['conversation_key'])+','+q(row['payload'].encode().hex())+');')
for row in json.loads((root/'authenticated-invalid.json').read_text()):lines.append(' check_invalid_payload('+q(row['conversation_key'])+','+q(row['payload'].encode().hex())+');')
for row in v['valid']['encrypt_decrypt_long_msg']:lines.append(' check_long('+q(row['conversation_key'])+','+q(row['nonce'])+','+q(row['pattern'].encode().hex())+','+str(row['repeat'])+','+q(row['plaintext_sha256'])+','+q(row['payload_sha256'])+');')
conv='c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d';nonce='0'*63+'1'
for length,plainhash,payloadhash in [(65535,'6e1bebca6a8229364a162a72ef064826c4cd7457bf54f190ef782bd9deff3e42','6d8c2810d1e870fbaa1f0a0937126cca837a15f9260e27060c331d70a3c0bc84'),(65536,'bf718b6f653bebc184e1479f1935b8da974d701b893afcf49e701f3e2f9f9c5a','b7b4edb36ba92e267d322d56d9aebc22e7fa96ff52e3c12adc07f07a43cbc616'),(65537,'008ffc88d3c96a9f307524eb361e47c5222a887fc45fa0c1fb8d429c5c23b430','eeb7c7c5373894ea2c1547cfd3ccb15d5a0b2d619da852e5c79df792dcc9e435')]:
 lines.append(' check_long('+q(conv)+','+q(nonce)+',"61",'+str(length)+','+q(plainhash)+','+q(payloadhash)+');')
# Older vector JSON rejects these lengths; the owning pinned spec explicitly extends them.
lines.append(' check_long('+q(conv)+','+q(nonce)+',"61",100000,NULL,NULL);')
lines.append(' check_long('+q(conv)+','+q(nonce)+',"61",HYPERGOLIC_NIP44_MAX_PLAINTEXT,NULL,NULL);')
lines+=[' CHECK(nip44_test_padded_length(0) == 0);',' CHECK(nip44_test_padded_length(10000000) == 0);','}']
args.output.write_text('\n'.join(lines)+'\n')
print('Generated',len(lines)-2,'official/vector extension checks; message-key rows',len(keys['keys']))
