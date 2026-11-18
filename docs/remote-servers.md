# Remote servers

Margarita can talk to the local OpenCode v2 service and to paired remote services in the
same TUI. Server identity is stored by margarita (OpenCode's `server.info` has no immutable
machine ID), so aliases are only labels.

## Setup

On the remote machine:

```sh
opencode serve --service
opencode pair --remote
```

`opencode pair --remote` prints a one-time pairing link. It expires after five minutes and
can be redeemed once. The server must be a compatible OpenCode v2 service.

Inside margarita:

```text
/pair https://host.example/auth/connect/<code> --as buildbox
/servers
/servers rename buildbox devbox
/unpair devbox
```

`/pair --url https://host.example --as buildbox` registers a manual URL. Its credential is
provided through the secure credential flow or `MARGARITA_SERVER_PASSWORD`, never through
the composer, argv, or saved drafts.

## CLI

```sh
marg --remote buildbox
marg --remote buildbox --cwd /home/me/lotus
marg --remote buildbox --cwd /home/me/lotus "fix the build"
marg --remote buildbox --resume ses_123
marg --local --cwd ~/work/lotus
marg --server https://host.example --cwd /srv/repo
```

`--remote` and `--local` are mutually exclusive and cannot be combined with `--server`.
A remote `--cwd` is always interpreted on the remote host; relative paths are rejected
because this machine's working directory does not exist there.

Cross-platform examples:

| Frontend | Server | `--cwd` |
| --- | --- | --- |
| Windows | Linux | `--cwd /home/me/app` |
| Linux | Windows | `--cwd 'C:\work\app'` |
| macOS | Linux | `--cwd /srv/project` |

## Security

- Use HTTPS, or an SSH/TLS tunnel to a loopback address. Plain HTTP with a password to a
  non-loopback host is refused unless `MARGARITA_ALLOW_INSECURE_HTTP=1` is set.
- Embedded URL credentials are rejected. The password is read from `MARGARITA_SERVER_PASSWORD`
  for direct `--server` connections.
- Secrets are stored in Windows DPAPI, macOS Keychain, or Linux Secret Service. If no
  credential store is available, margarita refuses to persist and asks you to re-pair.
- Pairing codes and tokens are redacted from notices, debug logs, and state files.
- `/unpair` removes local access and saved credentials. It does not revoke a token that was
  already issued on the OpenCode side, and it never deletes remote sessions or files.

## Offline and reconnect

Cached projects from an offline server remain visible and marked `[offline]`; they do not
count as Active or Needs input until fresh evidence arrives. Other servers stay usable while
one is unreachable. Reconnect rehydrates state per server. Unpair stops only that host's
frontend stream.
