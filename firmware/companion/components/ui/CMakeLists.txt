# Works as an ESP-IDF component and as a plain CMake library (host sim).
set(UI_SRCS
    theme.c face.c face_transform.c face_moods.c img_fx.c screens.c scr_home.c scr_today.c scr_focus.c scr_inbox.c scr_toast.c mood_rules.c
    scr_lost.c scr_ice.c scr_hold.c scr_pair.c scr_menu.c scr_tasks.c scr_timer.c orbit.c
    fonts/inter_16.c fonts/inter_24.c
    fonts/inter_20.c fonts/inter_28.c fonts/inter_40.c fonts/inter_clock_96.c)

if(ESP_PLATFORM)
    idf_component_register(SRCS ${UI_SRCS} INCLUDE_DIRS include REQUIRES lvgl__lvgl logic)
else()
    add_library(ui STATIC ${UI_SRCS})
    target_include_directories(ui PUBLIC include)
    target_link_libraries(ui PUBLIC lvgl)
endif()
