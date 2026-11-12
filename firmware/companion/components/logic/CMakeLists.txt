file(GLOB LOGIC_SRCS ${CMAKE_CURRENT_LIST_DIR}/*.c)
if(ESP_PLATFORM)
  idf_component_register(SRCS ${LOGIC_SRCS}
                         INCLUDE_DIRS include
                         PRIV_INCLUDE_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../main)
else()
  add_library(logic STATIC ${LOGIC_SRCS})
  target_include_directories(logic PUBLIC ${CMAKE_CURRENT_LIST_DIR}/include)
endif()
