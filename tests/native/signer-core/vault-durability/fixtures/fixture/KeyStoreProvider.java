package fixture;
import java.security.*;
import java.security.cert.Certificate;
import java.io.*;
import java.util.*;
import javax.crypto.*;
import android.security.keystore.KeyGenParameterSpec;

/** Explicit in-memory Keystore provider; AES/GCM operations themselves use actual host JCE. */
public final class KeyStoreProvider extends Provider {
  public static final Map<String, Key> keys = new HashMap<>();

  public KeyStoreProvider() {
    super("AndroidKeyStore", "1", "Disposable host Keystore double");
    put("KeyStore.AndroidKeyStore", Store.class.getName());
    put("KeyGenerator.AES", Generator.class.getName());
  }

  public static final class Generator extends KeyGeneratorSpi {
    String alias;

    protected void engineInit(SecureRandom r) {
      throw new UnsupportedOperationException();
    }

    protected void engineInit(int n, SecureRandom r) {
      throw new UnsupportedOperationException();
    }

    protected void engineInit(java.security.spec.AlgorithmParameterSpec p, SecureRandom r) {
      alias = ((KeyGenParameterSpec) p).alias;
    }

    protected SecretKey engineGenerateKey() {
      try {
        KeyGenerator g = KeyGenerator.getInstance("AES");
        g.init(256);
        SecretKey k = g.generateKey();
        keys.put(alias, k);
        return k;
      } catch (Exception e) {
        throw new RuntimeException(e);
      }
    }
  }

  public static final class Store extends KeyStoreSpi {
    public KeyStore.Entry engineGetEntry(String a, KeyStore.ProtectionParameter p) {
      Key k = keys.get(a);
      return k == null ? null : new KeyStore.SecretKeyEntry((SecretKey) k);
    }

    public Key engineGetKey(String a, char[] p) {
      return keys.get(a);
    }

    public Certificate[] engineGetCertificateChain(String a) {
      return null;
    }

    public Certificate engineGetCertificate(String a) {
      return null;
    }

    public Date engineGetCreationDate(String a) {
      return new Date(0);
    }

    public void engineSetKeyEntry(String a, Key k, char[] p, Certificate[] c) {
      keys.put(a, k);
    }

    public void engineSetKeyEntry(String a, byte[] k, Certificate[] c) {
      throw new UnsupportedOperationException();
    }

    public void engineSetCertificateEntry(String a, Certificate c) {
      throw new UnsupportedOperationException();
    }

    public void engineDeleteEntry(String a) {
      keys.remove(a);
    }

    public Enumeration<String> engineAliases() {
      return Collections.enumeration(keys.keySet());
    }

    public boolean engineContainsAlias(String a) {
      return keys.containsKey(a);
    }

    public int engineSize() {
      return keys.size();
    }

    public boolean engineIsKeyEntry(String a) {
      return keys.containsKey(a);
    }

    public boolean engineIsCertificateEntry(String a) {
      return false;
    }

    public String engineGetCertificateAlias(Certificate c) {
      return null;
    }

    public void engineStore(OutputStream o, char[] p) {}

    public void engineLoad(InputStream i, char[] p) {}
  }
}
