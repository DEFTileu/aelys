# Action journal NVS adapter prerequisite

Run from the repository root (no ESP-IDF, board, network, or shared CMake changes):

```sh
cc -std=c11 -Wall -Wextra -Werror -Ifirmware/companion/sim/action_journal_store/include -Ifirmware/companion/main -Ifirmware/companion/components/logic/include firmware/companion/sim/action_journal_store/test.c firmware/companion/components/logic/action_journal.c firmware/companion/main/action_journal_store.c -o /tmp/aelys-action-journal-store-test
/tmp/aelys-action-journal-store-test
```

This host RAM fake tests NVS API outcomes, not physical flash. It does not
establish NVS power-loss atomicity, persistence on actual hardware, wear,
or the behavior of every ESP-IDF failure. The adapter is not built into the
firmware, called by the app, or connected to pairing, actions, or sync.

The codec's V1 layout and binding are assumed unchanged. The caller must
validate the active public key, serialize the entire read/check/write sequence
against all other journal and pairing changes, and hold one store instance for
the process lifetime. A set or commit error fences that instance even if the
fake demonstrates the bytes were written. Reconstructing an instance is not a
recovery protocol; after reboot, a successful load reports the currently
readable bytes only, not whether an earlier ambiguous action was committed or
executed. The policy for resolving that ambiguity, identity changes, unpair,
retention/erasure, lost revision and epoch remains open. No auto erase occurs.
The existing action journal codec remains an unintegrated prerequisite; these
files make no product or decision-register claims.
