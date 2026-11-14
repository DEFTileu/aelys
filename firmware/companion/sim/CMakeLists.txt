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
target_link_libraries(logic PUBLIC m) # sfx.c builds its sine table with sinf
add_executable(sfx_preview sfx_preview.c)
target_link_libraries(sfx_preview PRIVATE logic)

add_library(simlib STATIC sim_display.c bmp.c sim_cues.c)
target_compile_options(simlib PRIVATE -Wall -Wextra)
target_include_directories(simlib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(simlib PUBLIC ui lvgl m)

add_executable(companion_sim sim_main.c)
target_link_libraries(companion_sim PRIVATE simlib)

enable_testing()
foreach(t test_face_transform test_face_raster_visual test_face_moods test_face_geometry test_bmp test_mood_rules test_screens test_screen_damage test_cue)
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE simlib)
    add_test(NAME ${t} COMMAND ${t})
endforeach()
foreach(t test_combo test_pwrkey test_screen_fsm test_store test_improv test_codec_util test_tribuf test_owner test_proto test_link_fsm test_link_core test_gesture test_beep test_perf_probe test_timer_core test_character test_character_report test_face_raster test_face_spring test_level test_games_core test_motion test_sfx)
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

# Compile the actual port into this host-only test; discard unrelated platform entry points.
foreach(port_test test_lv_port test_lv_port_probe)
    add_executable(${port_test} test_lv_port.c)
    target_include_directories(${port_test} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/port_fakes
        ${CMAKE_CURRENT_SOURCE_DIR}/../components/board/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../components/logic/include)
    target_compile_options(${port_test} PRIVATE -Wall -Wextra -ffunction-sections -fdata-sections)
    if(APPLE)
        target_link_options(${port_test} PRIVATE -Wl,-dead_strip)
    else()
        target_link_options(${port_test} PRIVATE -Wl,--gc-sections)
    endif()
    add_test(NAME ${port_test} COMMAND ${port_test})
    set_tests_properties(${port_test} PROPERTIES TIMEOUT 5)
endforeach()
target_compile_definitions(test_lv_port_probe PRIVATE CONFIG_AELYS_PERF_PROBE=1)

# Host-only regressions include the current link task and replace its IDF boundaries.
foreach(harness lifecycle inbound)
    add_executable(pairing_gate_${harness} pairing_gate/${harness}.c)
    target_compile_options(pairing_gate_${harness} PRIVATE -Wall -Wextra -Wno-unused-function -UNDEBUG)
    target_compile_definitions(pairing_gate_${harness} PRIVATE _DEFAULT_SOURCE)
    target_include_directories(pairing_gate_${harness} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/pairing_gate/fakes
        ${CMAKE_CURRENT_SOURCE_DIR}/../components/link
        ${CMAKE_CURRENT_SOURCE_DIR}/../components/link/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../components/identity/include)
    target_link_libraries(pairing_gate_${harness} PRIVATE logic Threads::Threads)
endforeach()
foreach(scenario sent unsent completed expired inflight admission admission-first lost-on lost-missing startup-pair startup-failure login-pair-connect cache-dirty cache-save-race cache-unpaired ui-clear-retry)
    add_test(NAME pairing_gate_lifecycle_${scenario} COMMAND pairing_gate_lifecycle ${scenario})
    set_tests_properties(pairing_gate_lifecycle_${scenario} PROPERTIES TIMEOUT 15)
endforeach()
foreach(scenario command result snapshot)
    add_test(NAME pairing_gate_inbound_${scenario} COMMAND pairing_gate_inbound ${scenario})
    set_tests_properties(pairing_gate_inbound_${scenario} PROPERTIES TIMEOUT 15)
endforeach()

# Exercise the real NVS adapter and snapshot codec against a host-only RAM fake.
add_executable(test_owned_nvs
    owned_nvs/test.c
    ../main/store_nvs.c
    ../components/logic/store_codec.c)
target_include_directories(test_owned_nvs PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/owned_nvs/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../main
    ${CMAKE_CURRENT_SOURCE_DIR}/../components/logic/include)
target_compile_definitions(test_owned_nvs PRIVATE explicit_bzero=owned_nvs_explicit_bzero)
target_compile_options(test_owned_nvs PRIVATE -Wall -Wextra)
add_test(NAME test_owned_nvs COMMAND test_owned_nvs)
