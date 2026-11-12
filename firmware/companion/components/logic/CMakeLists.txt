file(GLOB LOGIC_SRCS ${CMAKE_CURRENT_LIST_DIR}/*.c)
if(ESP_PLATFORM)
  idf_component_register(SRCS ${LOGIC_SRCS}
                         INCLUDE_DIRS include third_party/jsmn
                         PRIV_INCLUDE_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../main)
else()
  add_library(logic STATIC ${LOGIC_SRCS})
  target_include_directories(logic PUBLIC ${CMAKE_CURRENT_LIST_DIR}/include
                                          ${CMAKE_CURRENT_LIST_DIR}/third_party/jsmn)
endif()
