#pragma once
/* Minimal assert-style checks for ctest: a failed CHECK is reported and makes main() return 1. */
#include <stdio.h>

static int g_failed;
#define CHECK(cond) do { if (!(cond)) { g_failed++; \
    fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(a, b) do { long long a_ = (a), b_ = (b); if (a_ != b_) { g_failed++; \
    fprintf(stderr, "%s:%d: %s == %lld, expected %lld\n", __FILE__, __LINE__, #a, a_, b_); } } while (0)
