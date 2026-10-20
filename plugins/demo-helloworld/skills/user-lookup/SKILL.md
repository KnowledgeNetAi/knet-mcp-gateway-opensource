---
name: user-lookup
description: Look up a sample user in the demo Hello World connector by name, username or email, and summarize what the caller's role is allowed to see. Use when someone asks to find a demo user, or to check that the gateway connection works.
---

# User lookup

**Read `references/helloworld.md` before the first tool call.**

1. If the user only wants to know whether the connection works, call `hello`
   and report its message.
2. Otherwise call `user_search` with the name, username or email they gave.
3. One match: call `user_get` with its `id` and summarize the record.
   Several: list them (name, email, company) and ask which one.
4. Report only the fields that came back. A missing field means the caller's
   role does not include it.
