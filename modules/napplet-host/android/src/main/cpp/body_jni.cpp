#include <jni.h>
#include "PublishedBodyEnvelope.h"
extern "C" JNIEXPORT jboolean JNICALL
Java_org_nostrocket_hypergolic_host_PublishedBodyStore_validEnvelope(JNIEnv *env, jobject, jbyteArray data) {
  if (!data) return JNI_FALSE;
  const auto size = env->GetArrayLength(data);
  jbyte *bytes = env->GetByteArrayElements(data, nullptr);
  if (!bytes) return JNI_FALSE;
  const bool valid = hg_published_html_valid(reinterpret_cast<const uint8_t *>(bytes), size);
  env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
  return valid ? JNI_TRUE : JNI_FALSE;
}
