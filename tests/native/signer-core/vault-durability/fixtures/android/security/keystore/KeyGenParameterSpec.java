package android.security.keystore;

public final class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {
  public final String alias;

  private KeyGenParameterSpec(String a) {
    alias = a;
  }

  public static final class Builder {
    private final String alias;

    public Builder(String a, int p) {
      alias = a;
    }

    public Builder setKeySize(int n) {
      return this;
    }

    public Builder setBlockModes(String... v) {
      return this;
    }

    public Builder setEncryptionPaddings(String... v) {
      return this;
    }

    public Builder setRandomizedEncryptionRequired(boolean v) {
      return this;
    }

    public Builder setUnlockedDeviceRequired(boolean v) {
      return this;
    }

    public KeyGenParameterSpec build() {
      return new KeyGenParameterSpec(alias);
    }
  }
}
