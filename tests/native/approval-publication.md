# Approval publication loopback journey

Start the isolated relay server in a fresh directory, then point the isolated fixture entry at the port in its `ready.json`. Run the driver only after an explicit device handoff and source freeze:

```sh
node tests/relay/native-review-server.mjs --output /private/tmp/approval-relay --mode accept
python3 tests/native/approval_publication.py \
  --source "$PWD" --serial emulator-5556 \
  --expected-apk-sha256 "$HYPERGOLIC_FIXTURE_APK_SHA256" \
  --relay-ready /private/tmp/approval-relay/ready.json \
  --output /private/tmp/approval-publication approval-publication
```

The runner requires the existing scalar-2 public fixture identity and unchanged public Approval Lab note. It uses visible Settings, web content, and native approval controls only. Relay receipts are local loopback evidence; they do not establish public relay delivery or iOS behavior.

Pass `--revocation-only` only for the separate background-revocation journey. It switches the local server to `hold-upgrade`, visibly approves one request, backgrounds and returns to the app after all three upgrades are held, then releases them. The driver asserts that no protocol frame was emitted.
