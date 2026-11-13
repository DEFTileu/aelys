cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
if(NOT DEFINED PROJECT_VER)
  set(PROJECT_VER "0.2.0") # a test release can pass -DPROJECT_VER=x.y.z
endif()
project(companion)
# The display and its invalidation list live in the LVGL PSRAM heap. Sparse ring
# damage needs more slots than the default 32 to avoid a full-screen fallback.
idf_component_get_property(lvgl_lib lvgl__lvgl COMPONENT_LIB)
target_compile_definitions(${lvgl_lib} PUBLIC LV_INV_BUF_SIZE=64)
