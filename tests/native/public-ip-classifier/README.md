# Native public IP destination policy proof

Run `python3 tests/native/public-ip-classifier/run.py` from the repository root.
The runner compiles the actual Android Java and iOS Swift classifier sources with
warnings treated as errors, then applies the same vectors to both. The vectors cover
special-use IPv4/IPv6 boundaries, malformed literals, IPv4-mapped IPv6, and DNS
answer sets that mix public and non-public results.

This is a conservative address classifier only. A transport must resolve DNS itself,
reject the complete answer set if any result fails this policy, connect to one of the
validated numeric addresses without a second hostname lookup, and preserve TLS host
and certificate validation. This code does not perform DNS resolution, DNS pinning,
connection management, or TLS validation.
