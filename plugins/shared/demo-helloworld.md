# The demo Hello World connector: what to know before calling it

Source of truth for every skill in this plugin. Each skill carries an
identical copy (`scripts/build-plugin.sh` writes it).

## Tool names

The tools are named `helloworld_<name>`, for example `helloworld_user_search`.
Some clients show them with an extra connector prefix; match on the
`helloworld_...` part.

| Tool | Use it for |
|---|---|
| `hello` | Checking the connection. It never calls the upstream. |
| `user_search` | Finding sample users by name, username or email. |
| `user_get` | Opening one user by id. |
| `user_create` | Simulated create. DummyJSON returns a record but stores nothing. |

## What you will not see

The gateway filters every response by the caller's role. A `viewer` sees
names, email and employer only. Fields such as `ssn` or `bank` are absent, not
empty, so never tell the user a value "is blank". Say the role does not
include it.
