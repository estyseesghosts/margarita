#!/usr/bin/env python3
"""Executable smoke test: run the compiled `marg` under a real POSIX PTY.

Usage: pty-smoke.py <marg-binary> <stub-server-url> [scenario]

Scenarios:
  ctrl-c       paint, Ctrl+C exits 0, terminal restored (default)
  keys         typing, Unicode, backspace, Ctrl+J, bracketed paste, F1 help,
               Alt+P picker dismissal, Ctrl+O/R/S/T/B, F6: no crash, no submit
  mouse        SGR click/release/wheel over transcript and footer: no crash, no submit
  editor       Ctrl+G with an EDITOR path containing spaces: draft round-trips,
               temp directory removed, terminal usable after
  editor-fail  editor exits 1: draft kept, app keeps running
  sigterm      SIGTERM while idle: conventional exit status, terminal restored
  resize       repeated SIGWINCH down to 8 columns and back: no crash, draft kept
  crash        SIGKILL: only checks the harness still exits; modes cannot be restored

Asserts, from a directory unrelated to the checkout and with a minimal environment, that the
renderer initializes and visibly paints, that interactions do not submit anything unexpected
(the stub log records only GETs), and that the terminal is handed back with the cursor shown
and mouse reporting disabled. On failure the raw PTY transcript tail is printed to stderr
(it contains no credentials: the stub needs none).
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

PAINT_TIMEOUT = 20
EXIT_TIMEOUT = 15
ansi = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')


def read_until(fd, buffer, predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return True
        if not chunk:
            return True
        buffer.extend(chunk)
        if predicate(buffer):
            return True
    return False


def main():
    binary, url = sys.argv[1], sys.argv[2]
    scenario = sys.argv[3] if len(sys.argv) > 3 else 'ctrl-c'
    workdir = tempfile.mkdtemp(prefix='marg-smoke-')
    home = os.path.join(workdir, 'home')
    os.makedirs(home)
    tmp = os.path.join(workdir, 'tmp')
    os.makedirs(tmp)
    env = {
        'TERM': 'xterm-256color',
        'HOME': home,
        'PATH': '/usr/bin:/bin',
        'TMPDIR': tmp,
        'XDG_CONFIG_HOME': os.path.join(home, 'config'),
        'XDG_STATE_HOME': os.path.join(home, 'state'),
    }
    editor_dir = os.path.join(workdir, 'ed it or $meta')
    os.makedirs(editor_dir)
    editor = os.path.join(editor_dir, 'fake-editor.sh')
    with open(editor, 'w', encoding='utf-8') as handle:
        handle.write(
            '#!/bin/sh\n'
            'if [ -n "$MARG_EDITOR_FAIL" ]; then exit 1; fi\n'
            'printf " edited-by-editor" >> "$1"\n'
            'printf "%s" "$1" > "$MARG_EDITOR_SEEN"\n'
        )
    os.chmod(editor, 0o755)
    env['EDITOR'] = f"'{editor}'"
    if os.environ.get('MARGARITA_SERVER_PASSWORD'):
        env['MARGARITA_SERVER_PASSWORD'] = os.environ['MARGARITA_SERVER_PASSWORD']
    env['MARG_EDITOR_SEEN'] = os.path.join(workdir, 'editor-path')
    if scenario == 'editor-fail':
        env['MARG_EDITOR_FAIL'] = '1'
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.execve(binary, [binary, '--server', url], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    buffer = bytearray()
    failures = []

    def screen():
        return ansi.sub('', buffer.decode('utf-8', 'replace'))

    def settle(seconds=0.25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            read_until(fd, buffer, lambda _data: False, 0.05)

    def send(data):
        os.write(fd, data)
        settle()

    def expect(fragment, label):
        if not read_until(fd, buffer, lambda data: fragment in screen(), 8):
            failures.append(f'{label}: never saw {fragment!r}')

    def resize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def has_editor_temp():
        try:
            return any(name.startswith('margarita-') for name in os.listdir(tmp))
        except OSError:
            return False

    reaped = [None]

    def alive():
        if reaped[0] is not None:
            return False
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            reaped[0] = raw
            return False
        return True

    if not read_until(fd, buffer, lambda data: 'New session in' in screen(), PAINT_TIMEOUT):
        failures.append('renderer did not paint the new-session screen')

    if 'keys' in scenario:
        send('héllo wörld'.encode())
        expect('héllo wörld', 'Unicode typing')
        send(b'\x7f')
        send(b'\x0a')  # Ctrl+J: newline, never submit
        send('second line'.encode())
        expect('second line', 'Ctrl+J multiline editing')
        send(b'\x1b[200~pasted one\npasted two\x1b[201~')
        expect('pasted two', 'bracketed multi-line paste')
        # F1 help is asserted in the tmux smoke, where the terminal emulator translates
        # the key. Here we only prove that Escape is safe with a populated draft.
        send(b'\x1b')  # Esc, never submits
        send(b'\x1bp')  # Alt+P model picker (empty catalog)
        send(b'\x1b')  # dismiss
        send(b'\x0f\x12\x13\x14\x02')  # Ctrl+O/R/S/T/B
        send(b'\x1b[15~')  # F6 with an empty queue: no submit
        if not alive():
            failures.append('process died during keyboard input')
    elif scenario == 'mouse':
        for sequence in (
            b'\x1b[<0;10;10M', b'\x1b[<0;10;10m',
            b'\x1b[<64;10;10M', b'\x1b[<65;10;10M',
            b'\x1b[<0;1;29M', b'\x1b[<0;1;29m',
        ):
            send(sequence)
        if not alive():
            failures.append('process died during mouse input')
    elif scenario in ('editor', 'editor-fail'):
        send('draft text'.encode())
        expect('draft text', 'draft before editor')
        send(b'\x07')  # Ctrl+G
        if scenario == 'editor':
            if not read_until(
                fd,
                buffer,
                lambda _data: os.path.exists(env['MARG_EDITOR_SEEN']),
                15,
            ):
                failures.append('editor was not spawned with a quoted path')
            expect('edited-by-editor', 'edited text after resume')
            seen = ''
            try:
                with open(env['MARG_EDITOR_SEEN'], encoding='utf-8') as handle:
                    seen = handle.read()
            except OSError:
                pass
            if not seen.startswith(tmp) or not seen.endswith('/prompt.md'):
                failures.append(f'editor received the wrong temp path: {seen!r}')
            if has_editor_temp():
                failures.append('editor temp directory was not removed')
        else:
            expect('Editor exited with code 1', 'editor failure notice')
            expect('draft text', 'draft retained after editor failure')
    elif scenario == 'resize':
        for rows, cols in ((12, 40), (30, 8), (24, 80), (40, 120)):
            resize(rows, cols)
            os.kill(pid, signal.SIGWINCH)
            settle(0.4)
        send('still here'.encode())
        expect('still here', 'draft after repeated resize')
    elif scenario == 'sigterm':
        os.kill(pid, signal.SIGTERM)
    elif scenario == 'crash':
        os.kill(pid, signal.SIGKILL)

    if scenario not in ('sigterm', 'crash'):
        for _ in range(5):
            if not alive():
                break
            os.write(fd, b'\x03')
            time.sleep(0.4)
    status = None
    deadline = time.monotonic() + EXIT_TIMEOUT
    while time.monotonic() < deadline and status is None:
        read_until(fd, buffer, lambda _data: True, 0.2)
        if not alive():
            status = reaped[0]
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        failures.append('process did not exit')
    elif scenario == 'sigterm':
        ok = (os.WIFEXITED(status) and os.WEXITSTATUS(status) in (0, 143)) or (
            os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGTERM
        )
        if not ok:
            failures.append(f'unexpected status after SIGTERM {status}')
    elif scenario == 'crash':
        pass
    elif not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
        failures.append(f'unclean exit status {status}')
    text = buffer.decode('utf-8', 'replace')
    if scenario != 'crash':
        if '\x1b[?25h' not in text:
            failures.append('cursor was not re-shown on exit')
        if '\x1b[?1000h' in text and '\x1b[?1000l' not in text:
            failures.append('mouse reporting was left enabled')
    submitted = os.environ.get('STUB_LOG')
    if scenario in ('keys', 'mouse') and submitted and os.path.exists(submitted):
        with open(submitted, encoding='utf-8') as handle:
            writes = [line for line in handle.read().splitlines() if not line.startswith('GET ')]
        if writes:
            failures.append(f'keyboard input caused server writes: {writes}')
    if failures:
        print('PTY smoke FAILED:', *failures, sep='\n  - ', file=sys.stderr)
        print('--- transcript tail ---', file=sys.stderr)
        print(repr(text[-1500:]), file=sys.stderr)
        sys.exit(1)
    print(f'PTY smoke passed ({scenario})' + ('' if scenario == 'crash' else ': painted, terminal restored'))


main()
