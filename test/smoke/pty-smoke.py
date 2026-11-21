#!/usr/bin/env python3
"""Executable smoke test: run the compiled `marg` under a real PTY.

Usage: pty-smoke.py <marg-binary> <stub-server-url>

Asserts, from a directory unrelated to the checkout and with a minimal environment, that the
renderer initializes and visibly paints, that Ctrl+C exits cleanly with status 0, and that the
terminal is handed back with the cursor shown and mouse reporting disabled. On failure the raw
PTY transcript tail is printed to stderr (it contains no credentials: the stub needs none).
"""

import os
import pty
import re
import select
import signal
import sys
import tempfile
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
    workdir = tempfile.mkdtemp(prefix='marg-smoke-')
    home = os.path.join(workdir, 'home')
    os.makedirs(home)
    env = {
        'TERM': 'xterm-256color',
        'HOME': home,
        'PATH': '/usr/bin:/bin',
        'XDG_CONFIG_HOME': os.path.join(home, 'config'),
        'XDG_STATE_HOME': os.path.join(home, 'state'),
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.execve(binary, [binary, '--server', url], env)
    import fcntl
    import struct
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    buffer = bytearray()
    failures = []

    def painted(data):
        return 'New session in' in ansi.sub('', data.decode('utf-8', 'replace'))

    if not read_until(fd, buffer, painted, PAINT_TIMEOUT):
        failures.append('renderer did not paint the new-session screen')
    os.write(fd, b'\x03')
    time.sleep(0.5)
    os.write(fd, b'\x03')
    status = None
    deadline = time.monotonic() + EXIT_TIMEOUT
    while time.monotonic() < deadline and status is None:
        read_until(fd, buffer, lambda _data: True, 0.2)
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = raw
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        failures.append('process did not exit after Ctrl+C')
    elif not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
        failures.append(f'unclean exit status {status}')
    text = buffer.decode('utf-8', 'replace')
    if '\x1b[?25h' not in text:
        failures.append('cursor was not re-shown on exit')
    if '\x1b[?1000h' in text and '\x1b[?1000l' not in text:
        failures.append('mouse reporting was left enabled')
    if failures:
        print('PTY smoke FAILED:', *failures, sep='\n  - ', file=sys.stderr)
        print('--- transcript tail ---', file=sys.stderr)
        print(repr(text[-1500:]), file=sys.stderr)
        sys.exit(1)
    print('PTY smoke passed: painted, exited 0, terminal restored')


main()
