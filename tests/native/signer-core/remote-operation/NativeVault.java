package org.nostrocket.hypergolic.signercore;

/** Explicit host error port; production vault/storage/authentication is not exercised. */
final class NativeVault {
  static final class Error extends RuntimeException {
    private static final long serialVersionUID = 1L;
    final String code;
    Error(String code) { super(code); this.code = code; }
  }
}
