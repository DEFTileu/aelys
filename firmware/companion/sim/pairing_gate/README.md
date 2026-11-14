# Pairing gate host regression

This covers the companion device-channel pairing lifecycle (the companion link
milestone in the implementation plan). From the repository root:

```sh
cmake -S firmware/companion/sim -B firmware/companion/sim/build
cmake --build firmware/companion/sim/build --target pairing_gate_lifecycle pairing_gate_inbound
ctest --test-dir firmware/companion/sim/build -R '^pairing_gate_' --output-on-failure
```

The harnesses include the current production `link.c` and link the production
FSM, action table, parser and supporting logic. They replace IDF, identity,
network and UI boundaries with local host fakes. Every scenario runs in a fresh
process; pthread condition variables control the send and admission ordering.
Assertions stay enabled even in release builds. The suite covers sent, unsent,
completed and expired actions; send and admission barriers during pairing;
lost-mode refusal; startup and task-creation failure; pairing between login and
socket connect; and stale command, result and snapshot frames before and after
the pairing notification. The inbound cases first verify that each frame takes
effect on the old connection as a positive control.

Assumptions: frames may already be queued when a new identity is committed,
and an action may still be awaiting a result. A captured send is a transport
attempt, not proof of server receipt. The tests exercise selected host
interleavings, not FreeRTOS scheduling, actual identity persistence, real TLS,
server behavior, or hardware. They make no product decisions and resolve no
open questions; they do not establish completion of the link module.

Known open gaps: a persisted snapshot is not bound to an identity and may be
loaded after re-pairing; pending UI action results are not yet correlated with
an identity and UUID. This suite does not validate crash recovery, NVS write
ambiguity, or those cross-identity cases.
