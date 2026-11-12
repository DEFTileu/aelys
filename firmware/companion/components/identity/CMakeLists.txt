set(ID_PRIV "")
if(CONFIG_AELYS_IDENTITY_SELFTEST)
    # test vectors (generated TEST keys) are only compiled into the self-test image
    set(ID_PRIV PRIV_INCLUDE_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../sim)
endif()
idf_component_register(SRCS identity.c
                       INCLUDE_DIRS include
                       REQUIRES logic esp_common
                       PRIV_REQUIRES mbedtls freertos
                       ${ID_PRIV})
