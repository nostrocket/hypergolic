# Native Android approval lifetime

This JVM suite compiles the production `NativeApprovalAuthority.java` directly.
It tests opaque native handle ownership, exact FIFO approval, one-use snapshot
reads with a live grant until finish, focus/background revocation, dismissal and
explicit resume, 4/session and 16/global bounds, monotonic expiry and concurrent
approval. The native host must separately validate transport source/sequence and
bind the captured event, identity, publisher, app and destinations.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-approval-authority/runner.py \
  --output /private/tmp/hypergolic-android-approval-proof
```

The output must be new. Owning sources are hashed before and after compilation and
execution. Authentication, signing, relay delivery, Expo binding and native UI are
not part of this core proof. This authority is not yet connected to the host; it
does not enable publication or alter existing capability deadlines.
