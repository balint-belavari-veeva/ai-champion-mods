# Changes from Nate Herk's originals

- cache-keeper 2.0.1: the band (handoff button, session cost) now always shows, including in resumed chats; cache shows "unknown until next message" until the first prompt.
- cache-keeper 2.0.0: handoff is one click. `runHandoff` sets `H.auto`; once the handoff is captured, the chat clears and continues by itself (waits up to ~10s for the handoff turn to end). `/handoff continue` and the `clear and continue` button still work. Earlier local edit kept: the `ctx <tokens>` segment is removed from the band (the status line shows context fill).
- recording-mode, goal-meter, collision-guard 1.1.0: unchanged code; version bumped and author line added.
- Status line: Patrick's script (adds the `vault status` segment), unchanged.
