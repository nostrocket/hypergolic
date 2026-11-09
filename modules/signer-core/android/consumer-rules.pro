# JNI resolves this callback by exact class and member names (signer_jni.c).
-keep class org.nostrocket.hypergolic.signercore.NativeTransportCrypto {
    static byte[] hmac(byte[], byte[]);
}

# JNI ThrowNew uses this exact exception name and String constructor.
-keep class org.nostrocket.hypergolic.signercore.NativeSignerCore$Denied {
    <init>(java.lang.String);
}
