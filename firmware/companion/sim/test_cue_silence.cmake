string(RANDOM LENGTH 12 ALPHABET 0123456789abcdef nonce)
set(output "${CMAKE_CURRENT_BINARY_DIR}/night-cue-${nonce}.wav")
execute_process(COMMAND "${SIM_EXE}" --event-cue task-complete --hour 23 --out "${output}"
                RESULT_VARIABLE result OUTPUT_QUIET ERROR_QUIET)
if(NOT result EQUAL 3 OR EXISTS "${output}")
    message(FATAL_ERROR "Night event should be suppressed without creating a WAV (exit ${result})")
endif()
