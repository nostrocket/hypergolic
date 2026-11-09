#ifndef HG_MESH_STORE_TLS_FIXTURE_H
#define HG_MESH_STORE_TLS_FIXTURE_H
#include <stddef.h>
int mesh_store_fixture_generate(unsigned char *,size_t *,unsigned char *,size_t *,unsigned char *);
void *mesh_store_fixture_import(const unsigned char *,size_t,const unsigned char *,size_t);
int mesh_store_fixture_pin(void *,unsigned char *);
void mesh_store_fixture_close(void *);
#endif
