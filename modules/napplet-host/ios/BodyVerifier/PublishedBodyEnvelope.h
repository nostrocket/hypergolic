#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Validate the original UTF-8 bytes before offering an access review. */
int hg_published_html_valid(const uint8_t *bytes, size_t count);
#ifdef __cplusplus
}
#endif
