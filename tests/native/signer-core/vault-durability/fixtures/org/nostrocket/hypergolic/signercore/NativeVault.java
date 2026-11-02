package org.nostrocket.hypergolic.signercore;

final class NativeVault {
  static final class Error extends RuntimeException {
    final String code;

    Error(String c) {
      super(c);
      code = c;
    }
  }
}
