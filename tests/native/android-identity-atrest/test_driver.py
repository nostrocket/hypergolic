"""Admission controls: public-key validation and refusal to remove an unowned APK."""
import tempfile
from pathlib import Path
import unittest
from run import Proof, decode_npub, PACKAGE


class AdmissionTests(unittest.TestCase):
    def test_independent_known_public_key(self):
        self.assertEqual(decode_npub('npub183rrxlc9zht3lptqrjd98rxztxu5yztsek5thjwq7xp9vmr4ya6sx97kd5'),
            '3c46337f0515d71f85601c9a538cc259b9420970cda8bbc9c0f182566c752775')

    def test_invalid_checksum_cannot_bind_identity(self):
        for value in ['npub183rrxlc9zht3lptqrjd98rxztxu5yztsek5thjwq7xp9vmr4ya6sx97kdq',
                      'npub1' + 'q'*58, 'nsec1' + 'q'*58]:
            with self.subTest(value=value), self.assertRaises((RuntimeError,ValueError)):
                decode_npub(value)

    def test_changed_package_cannot_be_uninstalled(self):
        with tempfile.TemporaryDirectory() as folder:
            proof = Proof('unused', Path(folder), Path(folder)/'evidence')
            proof.owned[PACKAGE] = 'a'*64
            proof.installed = lambda _: 'b'*64
            def forbidden(*args, **kwargs):
                self.fail('ADB mutation invoked for mismatched package')
            proof.call = forbidden
            proof.ok = forbidden
            with self.assertRaisesRegex(RuntimeError,'Refuse removal of changed owned app'):
                proof.cleanup()
            self.assertEqual(proof.r['cleanup'], [])


if __name__ == '__main__':
    unittest.main()
