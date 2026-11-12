cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
if(NOT DEFINED PROJECT_VER)
  set(PROJECT_VER "0.2.0") # a test release can pass -DPROJECT_VER=x.y.z
endif()
project(companion)
