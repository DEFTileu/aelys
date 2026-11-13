cmake_minimum_required(VERSION 3.20)
project(companion_sim C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# Same LVGL version and config as the firmware (sim/lv_conf.h is the reference).
set(LV_BUILD_CONF_PATH ${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h CACHE STRING "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG OFF CACHE BOOL "" FORCE)           # C-only build, no vector graphics
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
set(LV_USE_FIND_PACKAGE OFF CACHE BOOL "" FORCE)
set(LV_USE_PKG_CONFIG OFF CACHE BOOL "" FORCE)
include(FetchContent)
FetchContent_Declare(lvgl
    GIT_REPOSITORY https://github.com/lvgl/lvgl.git
    GIT_TAG v9.6.0
    GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(lvgl)
target_compile_definitions(lvgl PUBLIC LV_INV_BUF_SIZE=64)
# lv_conf.h pulls in ui_lv_font.h (default font), so every LVGL file needs the ui include dir
target_include_directories(lvgl PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../components/ui/include)

add_subdirectory(../components/ui ui) # plain-library branch of the component CMakeLists
target_compile_options(ui PRIVATE -Wall -Wextra)
target_compile_definitions(ui PUBLIC CONFIG_AELYS_PERF_PROBE=1) # host exercises the bench-only safe UI entry point
target_compile_definitions(ui PUBLIC CONFIG_AELYS_SPARSE_SCREEN_SWITCH=1)

# Pure-C logic (no LVGL, no IDF); owner.c reads the example contacts, never the git-ignored local header.
add_subdirectory(../components/logic logic)
target_compile_options(logic PRIVATE -Wall -Wextra)
target_compile_definitions(logic PRIVATE OWNER_CONTACT_HEADER="owner_contact.example.h")
target_include_directories(logic PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../main)

target_link_libraries(ui PUBLIC logic) # screens use owner.h, screen_fsm.h, ui_events.h

add_library(simlib STATIC sim_display.c bmp.c sim_cues.c)
target_compile_options(simlib PRIVATE -Wall -Wextra)
target_include_directories(simlib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(simlib PUBLIC ui lvgl m)

add_executable(companion_sim sim_main.c)
target_link_libraries(companion_sim PRIVATE simlib)

enable_testing()
foreach(t test_face_moods test_face_geometry test_bmp test_mood_rules test_screens test_screen_damage test_cue)
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE simlib)
    add_test(NAME ${t} COMMAND ${t})
endforeach()
foreach(t test_combo test_pwrkey test_screen_fsm test_store test_improv test_codec_util test_tribuf test_owner test_proto test_link_fsm test_link_core test_gesture test_beep test_perf_probe test_character test_character_report test_face_spring)
    add_executable(${t} ${t}.c)
    target_compile_options(${t} PRIVATE -Wall -Wextra)
    target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../main) # example owner contacts
    target_link_libraries(${t} PRIVATE logic)
    add_test(NAME ${t} COMMAND ${t})
endforeach()
target_compile_definitions(test_proto PRIVATE PROTO_CORPUS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/proto_corpus")
find_package(Threads REQUIRED)
target_link_libraries(test_tribuf PRIVATE Threads::Threads)
target_link_libraries(test_character_report PRIVATE Threads::Threads)
target_link_libraries(test_perf_probe PRIVATE Threads::Threads)
add_test(NAME sim_shot_smoke COMMAND companion_sim --shot face:happy --out ${CMAKE_BINARY_DIR}/smoke.bmp)

add_test(NAME sim_cue_smoke COMMAND companion_sim --cue joy --out ${CMAKE_BINARY_DIR}/joy.wav)
add_test(NAME sim_event_cue_smoke COMMAND companion_sim --event-cue task-complete --out ${CMAKE_BINARY_DIR}/event-joy.wav)
add_test(NAME sim_event_cue_night COMMAND ${CMAKE_COMMAND} -DSIM_EXE=$<TARGET_FILE:companion_sim> -P ${CMAKE_CURRENT_SOURCE_DIR}/test_cue_silence.cmake)
add_test(NAME sim_character_tap_smoke COMMAND companion_sim --shot character_tap --out ${CMAKE_BINARY_DIR}/character-tap.bmp)
