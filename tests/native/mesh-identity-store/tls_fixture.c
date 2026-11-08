/* Host-only actual TLS credential callbacks, with no account keys/network. */
#include "tls_fixture.h"
#include "hypergolic_mesh_tls.h"
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
static int entropy(void *p,unsigned char *out,size_t n){(void)p;arc4random_buf(out,n);return 1;}
static int current(void *p){(void)p;return 1;}
static uint64_t clock_ms(void *p){(void)p;return 100;}
static hg_mesh_tls_owner owner(void){return(hg_mesh_tls_owner){NULL,entropy,current,clock_ms};}
typedef struct{unsigned char *key,*cert;size_t kl,cl;} Sink;
static int capture(void *p,const unsigned char *key,size_t kl,const unsigned char *cert,size_t cl){Sink*s=p;if(kl>s->kl||cl>s->cl)return 0;memcpy(s->key,key,kl);memcpy(s->cert,cert,cl);s->kl=kl;s->cl=cl;return 1;}
int mesh_store_fixture_generate(unsigned char *key,size_t *kl,unsigned char *cert,size_t *cl,unsigned char *pin){
 hg_mesh_tls_credential*c=NULL;Sink sink={key,cert,*kl,*cl};if(hg_mesh_tls_credential_generate(owner(),"20200101000000","20350101000000",&c)!=HG_MESH_TLS_OK)return 0;
 int ok=hg_mesh_tls_credential_store(c,capture,&sink)==HG_MESH_TLS_OK&&hg_mesh_tls_credential_pin(c,pin)==HG_MESH_TLS_OK;hg_mesh_tls_credential_destroy(c);*kl=sink.kl;*cl=sink.cl;return ok;
}
void *mesh_store_fixture_import(const unsigned char *key,size_t kl,const unsigned char *cert,size_t cl){hg_mesh_tls_credential*c=NULL;if(hg_mesh_tls_credential_import(owner(),key,kl,cert,cl,&c)!=HG_MESH_TLS_OK)return NULL;return c;}
int mesh_store_fixture_pin(void *p,unsigned char *pin){return p&&hg_mesh_tls_credential_pin(p,pin)==HG_MESH_TLS_OK;}
void mesh_store_fixture_close(void *p){hg_mesh_tls_credential_destroy(p);}
#ifdef HG_MESH_STORE_JNI
#include <jni.h>
static void erase(void*p,size_t n){volatile unsigned char*v=p;while(n--)*v++=0;}
JNIEXPORT jobjectArray JNICALL Java_org_nostrocket_hypergolic_mesh_IdentityProof_generate(JNIEnv*e,jclass type){
 (void)type;unsigned char key[2048],cert[2048],pin[32];size_t kl=sizeof key,cl=sizeof cert;jobjectArray out=NULL;
 if(mesh_store_fixture_generate(key,&kl,cert,&cl,pin)){jclass array=(*e)->FindClass(e,"[B");if(array){out=(*e)->NewObjectArray(e,3,array,NULL);size_t lens[]={kl,cl,32};unsigned char*values[]={key,cert,pin};for(int i=0;out&&i<3;i++){jbyteArray a=(*e)->NewByteArray(e,(jsize)lens[i]);if(!a)break;(*e)->SetByteArrayRegion(e,a,0,(jsize)lens[i],(jbyte*)values[i]);(*e)->SetObjectArrayElement(e,out,i,a);(*e)->DeleteLocalRef(e,a);}}}
 erase(key,sizeof key);erase(cert,sizeof cert);return out;
}
JNIEXPORT jlong JNICALL Java_org_nostrocket_hypergolic_mesh_IdentityProof_importCredential(JNIEnv*e,jclass type,jbyteArray key,jbyteArray cert){
 (void)type;unsigned char k[2048],c[2048];if(!key||!cert)return 0;jsize kl=(*e)->GetArrayLength(e,key),cl=(*e)->GetArrayLength(e,cert);if(kl<1||kl>2048||cl<1||cl>2048)return 0;
 (*e)->GetByteArrayRegion(e,key,0,kl,(jbyte*)k);(*e)->GetByteArrayRegion(e,cert,0,cl,(jbyte*)c);void*out=(*e)->ExceptionCheck(e)?NULL:mesh_store_fixture_import(k,(size_t)kl,c,(size_t)cl);erase(k,sizeof k);erase(c,sizeof c);return(jlong)(uintptr_t)out;
}
JNIEXPORT jbyteArray JNICALL Java_org_nostrocket_hypergolic_mesh_IdentityProof_pin(JNIEnv*e,jclass type,jlong handle){(void)type;unsigned char value[32];if(!mesh_store_fixture_pin((void*)(uintptr_t)handle,value))return NULL;jbyteArray a=(*e)->NewByteArray(e,32);if(a)(*e)->SetByteArrayRegion(e,a,0,32,(jbyte*)value);return a;}
JNIEXPORT void JNICALL Java_org_nostrocket_hypergolic_mesh_IdentityProof_closeCredential(JNIEnv*e,jclass type,jlong handle){(void)e;(void)type;mesh_store_fixture_close((void*)(uintptr_t)handle);}
#endif
