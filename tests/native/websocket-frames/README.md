# Published relay WebSocket frame decoder

`run.py` compiles the production Android Java decoder and iOS Swift decoder and
runs both against the same `vectors.tsv` inputs. It uses only `javac`, `java`,
`swiftc` and Python 3; no app build or network is involved.

The parser accepts unmasked server text frames, continuations, ping/pong and
close controls. It delivers only complete valid UTF-8 text messages and complete
control events. RSV/compression, masked server frames, binary/reserved opcodes,
invalid control frames, malformed lengths, invalid UTF-8, and frame/message
budget violations fail closed. Feed network chunks no larger than 8 KiB. Both a
raw frame (including its header) and the assembled text message are limited to
66,560 bytes, matching the relay-frame budget used by the JavaScript transport
contract. The parser does not connect sockets, decode relay JSON, or claim
end-to-end relay-query support.

Run with:

```sh
python3 tests/native/websocket-frames/run.py
```
