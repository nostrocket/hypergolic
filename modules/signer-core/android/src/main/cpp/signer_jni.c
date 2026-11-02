#include <jni.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include "hypergolic_signer.h"

/* Full-read OS entropy, including short reads and EINTR. Never logs or crosses JS. */
static int entropy(void *unused, unsigned char *out, size_t length) {
  (void)unused;
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  size_t offset = 0;
  while (offset < length) {
    ssize_t got = read(fd, out + offset, length - offset);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { close(fd); return 0; }
    offset += (size_t)got;
  }
  close(fd);
  return 1;
}
static hypergolic_signer_key *key(jlong value) { return (hypergolic_signer_key *)(uintptr_t)value; }
JNIEXPORT jlong JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_generate(JNIEnv *env, jclass type) {
  (void)env; (void)type;
  hypergolic_signer_key *result = NULL;
  if (!hypergolic_signer_generate(entropy, NULL, &result)) return 0;
  return (jlong)(uintptr_t)result;
}
JNIEXPORT jbyteArray JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_publicKey(JNIEnv *env, jclass type, jlong handle) {
  (void)type;
  unsigned char result[32];
  if (!handle || !hypergolic_signer_public_key(key(handle), result)) return NULL;
  jbyteArray output = (*env)->NewByteArray(env, 32);
  if (output) (*env)->SetByteArrayRegion(env, output, 0, 32, (const jbyte *)result);
  return output;
}
JNIEXPORT jbyteArray JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_sign(JNIEnv *env, jclass type, jlong handle, jbyteArray digest) {
  (void)type;
  if (!handle || !digest || (*env)->GetArrayLength(env, digest) != 32) return NULL;
  unsigned char message[32], signature[64];
  (*env)->GetByteArrayRegion(env, digest, 0, 32, (jbyte *)message);
  if ((*env)->ExceptionCheck(env) || !hypergolic_signer_sign_digest(key(handle), message, entropy, NULL, signature)) return NULL;
  jbyteArray output = (*env)->NewByteArray(env, 64);
  if (output) (*env)->SetByteArrayRegion(env, output, 0, 64, (const jbyte *)signature);
  return output;
}
JNIEXPORT void JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_destroy(JNIEnv *env, jclass type, jlong handle) {
  (void)env; (void)type;
  if (handle) hypergolic_signer_destroy(key(handle));
}

JNIEXPORT jlong JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_restore(JNIEnv *env, jclass type, jbyteArray scalar) {
  (void)type;
  if (!scalar || (*env)->GetArrayLength(env, scalar) != 32) return 0;
  unsigned char secret[32];
  (*env)->GetByteArrayRegion(env, scalar, 0, 32, (jbyte *)secret);
  hypergolic_signer_key *result = NULL;
  int ok = !(*env)->ExceptionCheck(env) && hypergolic_signer_import(secret, sizeof(secret), entropy, NULL, &result);
  volatile unsigned char *clear = secret;
  for (size_t i = 0; i < sizeof(secret); i++) clear[i] = 0;
  return ok ? (jlong)(uintptr_t)result : 0;
}
typedef struct { JNIEnv *env; jobject sink; } secret_sink_context;
static int write_secret(void *context, const unsigned char *secret, size_t length) {
  secret_sink_context *state = context;
  JNIEnv *env = state->env;
  if (length != 32) return 0;
  jclass type = (*env)->GetObjectClass(env, state->sink);
  if (!type) return 0;
  jmethodID write = (*env)->GetMethodID(env, type, "write", "([B)V");
  (*env)->DeleteLocalRef(env, type);
  if (!write) return 0;
  jbyteArray bytes = (*env)->NewByteArray(env, 32);
  if (!bytes) return 0;
  (*env)->SetByteArrayRegion(env, bytes, 0, 32, (const jbyte *)secret);
  if (!(*env)->ExceptionCheck(env)) (*env)->CallVoidMethod(env, state->sink, write, bytes);
  jthrowable failure = (*env)->ExceptionOccurred(env);
  if (failure) (*env)->ExceptionClear(env);
  const jbyte zero[32] = {0};
  (*env)->SetByteArrayRegion(env, bytes, 0, 32, zero);
  (*env)->DeleteLocalRef(env, bytes);
  if (failure) { (*env)->Throw(env, failure); (*env)->DeleteLocalRef(env, failure); return 0; }
  return !(*env)->ExceptionCheck(env);
}
JNIEXPORT void JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_serialize(JNIEnv *env, jclass type, jlong handle, jobject sink) {
  (void)type;
  secret_sink_context context = {env, sink};
  if (handle && sink && hypergolic_signer_serialize(key(handle), write_secret, &context)) return;
  if (!(*env)->ExceptionCheck(env)) {
    jclass denied = (*env)->FindClass(env, "org/nostrocket/hypergolic/signercore/NativeSignerCore$Denied");
    if (denied) (*env)->ThrowNew(env, denied, "Native signing request denied.");
  }
}

#include <stdlib.h>
#include "hypergolic_nip44.h"

static void clear_owned(void *bytes, size_t length) {
  volatile unsigned char *out = bytes;
  while (length--) *out++ = 0;
}
static void clear_array(JNIEnv *env, jbyteArray bytes) {
  if (!bytes) return;
  jthrowable failure = (*env)->ExceptionOccurred(env);
  if (failure) (*env)->ExceptionClear(env);
  const jbyte zero[1024] = {0};
  jsize length = (*env)->GetArrayLength(env, bytes);
  for (jsize offset = 0; offset < length; offset += 1024) {
    jsize count = length - offset < 1024 ? length - offset : 1024;
    (*env)->SetByteArrayRegion(env, bytes, offset, count, zero);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); break; }
  }
  if (failure) { (*env)->Throw(env, failure); (*env)->DeleteLocalRef(env, failure); }
}
JNIEXPORT jboolean JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_validPoint(JNIEnv *env, jclass type, jbyteArray peer) {
  (void)type;
  if (!peer || (*env)->GetArrayLength(env, peer) != 32) return JNI_FALSE;
  unsigned char bytes[32]; (*env)->GetByteArrayRegion(env, peer, 0, 32, (jbyte *)bytes);
  return !(*env)->ExceptionCheck(env) && hypergolic_signer_public_key_valid(bytes) ? JNI_TRUE : JNI_FALSE;
}
JNIEXPORT jboolean JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_verifyDigest(JNIEnv *env, jclass type, jbyteArray peer, jbyteArray digest, jbyteArray signature) {
  (void)type;
  if (!peer || !digest || !signature || (*env)->GetArrayLength(env, peer) != 32 || (*env)->GetArrayLength(env, digest) != 32 || (*env)->GetArrayLength(env, signature) != 64) return JNI_FALSE;
  unsigned char p[32], d[32], s[64];
  (*env)->GetByteArrayRegion(env, peer, 0, 32, (jbyte *)p);
  (*env)->GetByteArrayRegion(env, digest, 0, 32, (jbyte *)d);
  (*env)->GetByteArrayRegion(env, signature, 0, 64, (jbyte *)s);
  return !(*env)->ExceptionCheck(env) && hypergolic_signer_verify_digest(p, d, s) ? JNI_TRUE : JNI_FALSE;
}
typedef struct { JNIEnv *env; jclass type; jmethodID hmac; jobject sink; jmethodID write; } nip44_context;
static int platform_hmac(void *context, const unsigned char *key_bytes, size_t key_length,
    const unsigned char *message, size_t message_length, unsigned char out32[32]) {
  nip44_context *state = context; JNIEnv *env = state->env;
  if ((key_length != 8 && key_length != 32) || message_length > HYPERGOLIC_NIP44_MAX_PAYLOAD + 32) return 0;
  jbyteArray key_array = (*env)->NewByteArray(env, (jsize)key_length);
  jbyteArray message_array = (*env)->NewByteArray(env, (jsize)message_length);
  jbyteArray result = NULL;
  int success = 0;
  if (!key_array || !message_array) goto finish;
  (*env)->SetByteArrayRegion(env, key_array, 0, (jsize)key_length, (const jbyte *)key_bytes);
  (*env)->SetByteArrayRegion(env, message_array, 0, (jsize)message_length, (const jbyte *)message);
  if ((*env)->ExceptionCheck(env)) goto finish;
  result = (*env)->CallStaticObjectMethod(env, state->type, state->hmac, key_array, message_array);
  if (!(*env)->ExceptionCheck(env) && result && (*env)->GetArrayLength(env, result) == 32) {
    (*env)->GetByteArrayRegion(env, result, 0, 32, (jbyte *)out32);
    success = !(*env)->ExceptionCheck(env);
  }
finish:
  if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
  clear_array(env, key_array); clear_array(env, message_array); clear_array(env, result);
  if (key_array) (*env)->DeleteLocalRef(env, key_array);
  if (message_array) (*env)->DeleteLocalRef(env, message_array);
  if (result) (*env)->DeleteLocalRef(env, result);
  return success;
}
static int write_transport(void *context, const unsigned char *bytes, size_t length) {
  nip44_context *state = context; JNIEnv *env = state->env;
  if (length > HYPERGOLIC_NIP44_MAX_PAYLOAD) return 0;
  jbyteArray copy = (*env)->NewByteArray(env, (jsize)length);
  if (!copy) { (*env)->ExceptionClear(env); return 0; }
  (*env)->SetByteArrayRegion(env, copy, 0, (jsize)length, (const jbyte *)bytes);
  if (!(*env)->ExceptionCheck(env)) (*env)->CallVoidMethod(env, state->sink, state->write, copy);
  int success = !(*env)->ExceptionCheck(env);
  if (!success) (*env)->ExceptionClear(env);
  clear_array(env, copy); (*env)->DeleteLocalRef(env, copy);
  return success;
}
JNIEXPORT jint JNICALL Java_org_nostrocket_hypergolic_signercore_NativeSigningKey_transportCrypt(JNIEnv *env, jclass type, jlong handle,
    jbyteArray peer, jbyteArray input, jboolean encrypting, jobject sink) {
  (void)type;
  if (!handle || !peer || !input || !sink || (*env)->GetArrayLength(env, peer) != 32) return HYPERGOLIC_NIP44_INVALID;
  jsize length = (*env)->GetArrayLength(env, input);
  size_t maximum = encrypting ? HYPERGOLIC_NIP44_MAX_PLAINTEXT : HYPERGOLIC_NIP44_MAX_PAYLOAD;
  if (length < 1 || (size_t)length > maximum) return HYPERGOLIC_NIP44_INVALID;
  unsigned char peer_bytes[32];
  unsigned char *owned_input = malloc((size_t)length);
  if (!owned_input) return HYPERGOLIC_NIP44_CRYPTO_FAILED;
  nip44_context context = {env, NULL, NULL, sink, NULL};
  int status = HYPERGOLIC_NIP44_CRYPTO_FAILED;
  (*env)->GetByteArrayRegion(env, peer, 0, 32, (jbyte *)peer_bytes);
  (*env)->GetByteArrayRegion(env, input, 0, length, (jbyte *)owned_input);
  context.type = (*env)->FindClass(env, "org/nostrocket/hypergolic/signercore/NativeTransportCrypto");
  jclass sink_type = (*env)->GetObjectClass(env, sink);
  if (!context.type || !sink_type || (*env)->ExceptionCheck(env)) goto finish;
  context.hmac = (*env)->GetStaticMethodID(env, context.type, "hmac", "([B[B)[B");
  context.write = (*env)->GetMethodID(env, sink_type, "write", "([B)V");
  if (!context.hmac || !context.write || (*env)->ExceptionCheck(env)) goto finish;
  hypergolic_nip44_crypto crypto = {platform_hmac, &context, entropy, NULL};
  hypergolic_nip44_bytes peer_span = {peer_bytes, 32}, input_span = {owned_input, (size_t)length};
  status = encrypting ? hypergolic_nip44_encrypt(key(handle), peer_span, input_span, &crypto, write_transport, &context)
                     : hypergolic_nip44_decrypt(key(handle), peer_span, input_span, &crypto, write_transport, &context);
finish:
  clear_owned(owned_input, (size_t)length); free(owned_input);
  if (context.type) (*env)->DeleteLocalRef(env, context.type);
  if (sink_type) (*env)->DeleteLocalRef(env, sink_type);
  if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
  return status;
}
