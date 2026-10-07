#!/usr/bin/env python3
"""Run a command on a pseudo-terminal and answer one confirmation phrase.

stdin and stdout are the terminal, so Node reports them as TTYs. stderr stays
a pipe. After the child writes a line ending in "to confirm:", this writes
PHRASE and Enter (CR) to the terminal. The child is the foreground process of
that terminal so readline can leave raw mode and exit. Echo is turned off so
the phrase is not mixed into the JSON the command prints on stdout.

MCP stdio and a non-TTY `tw` cannot use this. Local e2e scripts are the operator
for `tw send` and oracle-key `tw escrow settle`.
"""

import fcntl
import os
import pty
import select
import subprocess
import sys
import termios


def become_foreground_tty(slave_fd: int) -> None:
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tw-tty-confirm.py PHRASE COMMAND [ARG ...]", file=sys.stderr)
        return 2

    phrase = sys.argv[1]
    command = sys.argv[2:]
    master, slave = pty.openpty()
    attrs = termios.tcgetattr(slave)
    attrs[3] = attrs[3] & ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attrs)

    proc = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=subprocess.PIPE,
        preexec_fn=lambda: become_foreground_tty(slave),
    )
    os.close(slave)

    sent = False
    stdout = bytearray()
    stderr = bytearray()

    def send_phrase_if_prompted() -> None:
        nonlocal sent
        if sent or b"to confirm:" not in stderr:
            return
        # Readline on a TTY treats Enter as CR. A newline is not a line ending there.
        os.write(master, (phrase + "\r").encode())
        sent = True

    master_open = True
    stderr_open = proc.stderr is not None

    def watch_fds() -> list[int]:
        fds: list[int] = []
        if master_open:
            fds.append(master)
        if stderr_open and proc.stderr is not None:
            fds.append(proc.stderr.fileno())
        return fds

    def consume(stream: int) -> None:
        nonlocal master_open, stderr_open
        if stream == master:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                master_open = False
                return
            stdout.extend(chunk)
            return
        if proc.stderr is None:
            stderr_open = False
            return
        chunk = os.read(proc.stderr.fileno(), 65536)
        if not chunk:
            stderr_open = False
            return
        stderr.extend(chunk)
        sys.stderr.buffer.write(chunk)
        sys.stderr.buffer.flush()
        send_phrase_if_prompted()

    while proc.poll() is None:
        watch = watch_fds()
        if not watch:
            break
        readable, _, _ = select.select(watch, [], [], 60)
        if not readable:
            proc.kill()
            print("timed out waiting for terminal confirmation", file=sys.stderr)
            return 1
        for stream in readable:
            consume(stream)

    # The child has exited. Drain leftover bytes, and stop when a fd hits EOF
    # so a closed PTY cannot reset the wait forever.
    for _ in range(20):
        watch = watch_fds()
        if not watch:
            break
        readable, _, _ = select.select(watch, [], [], 0.1)
        if not readable:
            break
        for stream in readable:
            consume(stream)

    status = proc.wait()
    sys.stdout.buffer.write(stdout)
    sys.stdout.buffer.flush()
    try:
        os.close(master)
    except OSError:
        pass
    return status


if __name__ == "__main__":
    sys.exit(main())
