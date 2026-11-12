# Works as an ESP-IDF component and as a plain CMake library (host sim).
set(UI_SRCS
    theme.c face.c face_moods.c
    fonts/inter_20.c fonts/inter_28.c fonts/inter_40.c fonts/inter_clock_96.c
    fonts/inter_bold_fx_24.c fonts/inter_bold_fx_34.c fonts/inter_bold_fx_54.c
    fonts/inter_bold_fx_36.c fonts/inter_bold_fx_51.c fonts/inter_bold_fx_81.c)

if(ESP_PLATFORM)
    idf_component_register(SRCS ${UI_SRCS} INCLUDE_DIRS include REQUIRES lvgl__lvgl)
else()
    add_library(ui STATIC ${UI_SRCS})
    target_include_directories(ui PUBLIC include)
    target_link_libraries(ui PUBLIC lvgl)
endif()
